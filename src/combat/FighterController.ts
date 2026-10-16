// 파이터 1명의 상태 머신: 입력 → 보법/코어 물리 → 사지 궤적 → 포즈 → 밸런스
// 플레이어(키보드)와 AI(가상 입력)가 동일한 컨트롤러를 사용한다.
import {
  DIM, FootPlanner, TorsoFrame, computeTorso, defaultElbowPole, defaultKneePole, fistPoint, footHome, guardHand,
  solvePose,
} from '../animation/ProceduralFighterRig';
import {
  FEINT_BLEND_TIME, FEINT_U_MAX, bezierPoint, blendCurves, buildTrajectory, strikeDuration, strikerPart,
  trajectoryShape,
} from '../animation/TrajectoryGenerator';
import {
  Vec3, ZERO, add, addScaled, clamp, dirToWorld, distance, distanceXZ, dot, flatXZ, length, lerp, lerpNum, normalize,
  scale, smoothstep, springStep, sub, toLocal, toWorld, v3, wrapAngle, yawBasis, yawTowards,
} from '../core/math';
import { InputBuffer, evaluateChain } from '../input/ErgonomicInputManager';
import {
  BRAZILIAN_U_MAX, BRAZILIAN_U_MIN, TECHNIQUES, classifyTechnique, matchesDoubleLeg,
} from '../input/TechniqueClassifier';
import { BalanceMonitor, STUMBLE_DURATION, evaluateBalance } from '../physics/BalanceSystem';
import {
  CoreState, GROUND_IMPULSE, IMPULSE_DECAY, STEP_SPEED, commitSpin, computeImpact, createCoreState, currentOmega,
  effectiveMass, peakOmega, rotationDegrees, stepCore,
} from '../physics/KineticChainEngine';
import {
  BalanceState, BezierCurve, ChainEvaluation, ChainGrade, ChainTelemetry, ControlKey, FighterStatus, GROUND_KEYS,
  GrabPart, HitZone, LIMB_BY_KEY, LimbId, LimbKey, MassFactor, Pose, Side, StrikeLevel, StrikerPart, TechniqueResult,
  TrajectoryFlags, TrajectoryShape, WorldEvent, isLegLimb, limbSide,
} from '../types/combat';

const HOLD_TIME = 0.05;
const ARM_RETRACT = 0.18;
const LEG_RETRACT = 0.26;
export const HIT_ACTIVE_U = 0.35;
const RING_RADIUS = 4.5;
const KNOCKDOWN_TIME = 1.6;
const TAKEDOWN_KNOCKDOWN_TIME = 2.0;
const KO_TIME = 2.8;
const PARRY_STUN = 0.4;
export const MAX_HP = 100;

export const ZONE_MULTIPLIER: Record<HitZone, number> = { head: 1.4, liver: 1.6, body: 1.0, leg: 0.8 };
export const DAMAGE_SCALE = 0.9;
export const GUARD_DAMAGE_FACTOR = 0.25;

export interface Strike {
  id: number;
  limb: LimbId;
  side: Side;
  isLeg: boolean;
  startTime: number;
  duration: number;
  u: number;
  phase: 'extend' | 'hold' | 'retract';
  phaseT: number;
  frameYaw: number;
  level: StrikeLevel;
  curve: BezierCurve;
  blendFrom: BezierCurve | null;
  blendTo: BezierCurve | null;
  blendT: number;
  flags: TrajectoryFlags;
  shape: TrajectoryShape;
  striker: StrikerPart;
  chain: ChainEvaluation;
  mEff: number;
  massFactors: MassFactor[];
  coreDir: -1 | 0 | 1;
  groundPush: boolean;
  keys: Set<ControlKey>;
  feintWindowKeys: Set<ControlKey>;
  feints: { code: ControlKey; u: number }[];
  rotationPeak: number;
  technique: TechniqueResult;
  hasHit: boolean;
  localTarget: Vec3 | null;
  /** 회수 중 재발사 시 시작 위치 (로컬) */
  launchFrom: Vec3 | null;
  prevTipLocal: Vec3 | null;
  limbPathPrev: Vec3 | null;
  vLimbLocal: Vec3;
  retractFrom: Vec3;
  tip: Vec3;
  impulse: number;
}

interface Takedown {
  t: number;
  dur: number;
  chain: ChainEvaluation;
  mEff: number;
  massFactors: MassFactor[];
  resolved: boolean;
}

interface Clinch {
  part: GrabPart;
  wristSide: Side | null;
  since: number;
}

export interface FighterOptions {
  name: string;
  hasHp: boolean;
  pos: Vec3;
  color: number;
  /** 키보드 등 외부 입력 버퍼 (없으면 가상 입력용 버퍼 생성) */
  input?: InputBuffer;
}

let strikeSeq = 1;

export class FighterController {
  readonly name: string;
  readonly hasHp: boolean;
  readonly color: number;
  readonly input: InputBuffer;
  hp = MAX_HP;

  pos: Vec3;
  moveVel: Vec3 = ZERO;
  impulseVel: Vec3 = ZERO;
  knockVel: Vec3 = ZERO;
  faceYaw = 0;
  readonly core: CoreState = createCoreState();
  duck = 0;
  private duckVel = 0;
  lean = 0;
  private leanVel = 0;
  private pelvisShift: Vec3 = ZERO;
  private strikePitch = 0;
  fall = 0;
  wobble = 0;

  status: FighterStatus = 'normal';
  statusT = 0;
  statusDur = 0;

  readonly strikes = new Map<LimbId, Strike>();
  takedown: Takedown | null = null;
  clinch: Clinch | null = null;
  clinchedBy: FighterController | null = null;
  heldWrist: { side: Side; by: FighterController } | null = null;
  parryAnim: { side: Side; t: number; dur: number } | null = null;
  grabMiss: { t: number; dur: number } | null = null;
  guardUp = false;

  /** 샌드백 모드: 이 위치로 천천히 복귀 */
  anchor: Vec3 | null = null;

  readonly feet: FootPlanner;
  torso!: TorsoFrame;
  pose!: Pose;
  balance!: BalanceState;
  readonly monitor = new BalanceMonitor();
  supportFeet: Vec3[] = [];

  telemetry: ChainTelemetry | null = null;
  readonly energy = {
    ground: -Infinity,
    core: -Infinity,
    limbs: { leftArm: -Infinity, rightArm: -Infinity, leftLeg: -Infinity, rightLeg: -Infinity } as Record<LimbId, number>,
    grade: 'isolated' as ChainGrade,
  };
  hitFlash = -Infinity;
  events: WorldEvent[] = [];
  now = 0;

  constructor(opts: FighterOptions) {
    this.name = opts.name;
    this.hasHp = opts.hasHp;
    this.color = opts.color;
    this.input = opts.input ?? new InputBuffer();
    this.pos = opts.pos;
    this.feet = new FootPlanner(this.pos, 0);
    this.solveBody(1 / 120, null);
    this.updateBalance(0);
  }

  // ───────── 공개 상태 ─────────
  get heading(): number {
    return this.faceYaw + this.core.spinOffset;
  }

  get velocity(): Vec3 {
    return add(add(this.moveVel, this.impulseVel), this.knockVel);
  }

  get actionable(): boolean {
    return this.status === 'normal' || this.status === 'hitstun';
  }

  get downed(): boolean {
    return this.status === 'knockdown' || this.status === 'ko';
  }

  resetTo(pos: Vec3, faceYaw: number): void {
    this.pos = pos;
    this.faceYaw = faceYaw;
    this.moveVel = this.impulseVel = this.knockVel = ZERO;
    this.strikes.clear();
    this.takedown = null;
    this.releaseClinch();
    this.status = 'normal';
    this.fall = 0;
    this.hp = MAX_HP;
    Object.assign(this.core, createCoreState());
    this.duck = this.duckVel = this.lean = this.leanVel = 0;
    this.pelvisShift = ZERO;
    this.parryAnim = this.grabMiss = null;
    this.heldWrist = null;
    this.clinchedBy = null;
    this.telemetry = null;
    this.monitor.reset();
    this.feet.reset(pos, faceYaw);
  }

  // ───────── 메인 업데이트 ─────────
  update(dt: number, now: number, opp: FighterController): void {
    this.now = now;
    this.updateStatus(dt);
    for (const ev of this.input.drain()) {
      if (ev.down) this.onPress(ev.code, ev.time, opp);
      else this.onRelease(ev.code);
    }

    // 상대를 향한 자동 정렬 (스핀은 별도 오프셋)
    if (!this.downed) {
      const target = yawTowards(this.pos, opp.pos);
      this.faceYaw = wrapAngle(this.faceYaw + wrapAngle(target - this.faceYaw) * (1 - Math.exp(-10 * dt)));
    }

    this.updateLocomotion(dt);
    const coreOk = this.actionable && !this.takedown;
    // 팔로스루: 회전과 함께 발사된 타격이 뻗는 동안에는 코어 회전을 유지한다
    let followQ = false;
    let followE = false;
    for (const s of this.strikes.values()) {
      if (s.phase === 'retract') continue;
      if (s.coreDir === 1) followQ = true;
      if (s.coreDir === -1) followE = true;
    }
    const qDown = this.input.isDown('KeyQ');
    const eDown = this.input.isDown('KeyE');
    stepCore(
      this.core,
      {
        q: coreOk && (qDown || (followQ && !eDown)),
        e: coreOk && (eDown || (followE && !qDown)),
        qHeld: this.input.heldFor('KeyQ', now),
        eHeld: this.input.heldFor('KeyE', now),
        canSpin: coreOk && !this.clinch,
      },
      dt,
      now,
    );
    let duckTarget = this.takedown ? 1 : this.actionable && this.input.isDown('ShiftLeft') ? 1 : 0;
    // 어퍼컷: 낮춘 자세에서 다리로 밀어 올리며 친다
    for (const s of this.strikes.values()) {
      if (!s.isLeg && s.shape === 'verticalUp' && s.phase !== 'retract') duckTarget *= 1 - smoothstep(0.1, 0.7, s.u);
    }
    [this.duck, this.duckVel] = springStep(this.duck, this.duckVel, duckTarget, 16, 0.9, dt);
    const leanTarget = this.actionable && this.input.isDown('ControlLeft') ? 1 : 0;
    [this.lean, this.leanVel] = springStep(this.lean, this.leanVel, leanTarget, 14, 0.9, dt);

    this.updateClinch(dt, opp);
    this.updateStrikes(dt);
    this.updateTakedown(dt, opp);
    if (this.parryAnim && (this.parryAnim.t += dt) >= this.parryAnim.dur) this.parryAnim = null;
    if (this.grabMiss && (this.grabMiss.t += dt) >= this.grabMiss.dur) this.grabMiss = null;
    this.guardUp =
      this.actionable && this.input.isDown('Semicolon') && !this.clinch && !this.takedown &&
      !this.armStrikeActive();

    this.solveBody(dt, opp);
    this.updateBalance(dt);
    this.updateLiveTelemetry();
  }

  // ───────── 입력 처리 ─────────
  private onPress(code: ControlKey, t: number, opp: FighterController): void {
    // 비틀거림·다운 중에는 입력 페널티 (무시)
    if (!this.actionable) return;

    if (GROUND_KEYS.includes(code)) {
      this.energy.ground = t;
      this.emit({ type: 'energy', fighter: this.name, stage: 'ground', limb: null, time: t });
    }
    if (code === 'Space') {
      const dir = this.moveInputDir();
      const d = length(dir) > 0 ? dir : yawBasis(this.faceYaw).forward;
      this.impulseVel = addScaled(this.impulseVel, d, GROUND_IMPULSE);
    }
    if (code === 'KeyQ' || code === 'KeyE') {
      this.energy.core = t;
      this.emit({ type: 'energy', fighter: this.name, stage: 'core', limb: null, time: t });
      if (this.monitor.actionSpike(this.balance.ratio)) this.startStumble();
      if (!this.actionable) return;
    }
    if (code === 'KeyL' || code === 'KeyO' || code === 'Semicolon' || code === 'KeyQ' || code === 'KeyE') {
      this.applyFeint(code, opp);
    }
    if (code === 'Semicolon' && !this.armStrikeActive() && !this.clinch) {
      this.emitTechnique(TECHNIQUES.guard, null, null, false);
    }
    if (code === 'KeyU' || code === 'KeyI' || code === 'KeyJ' || code === 'KeyK') {
      this.handleLimb(code, t, opp);
    } else if (code === 'KeyM') {
      this.handleGrab(t, opp);
    }
  }

  private onRelease(code: ControlKey): void {
    if (code === 'KeyM' && this.clinch) this.releaseClinch();
  }

  private moveInputDir(): Vec3 {
    const b = yawBasis(this.faceYaw);
    let f = 0;
    let r = 0;
    if (this.input.isDown('KeyW')) f += 1;
    if (this.input.isDown('KeyS')) f -= 1;
    if (this.input.isDown('KeyD')) r += 1;
    if (this.input.isDown('KeyA')) r -= 1;
    if (f === 0 && r === 0) return ZERO;
    return normalize(add(scale(b.forward, f), scale(b.right, r)));
  }

  /** 현재 유효한 코어 회전 방향: 유지 중이거나 조합 윈도우 내에 눌린 Q/E 중 최신 */
  private resolveCoreDir(t: number): -1 | 0 | 1 {
    const q = this.input.isActive('KeyQ', t);
    const e = this.input.isActive('KeyE', t);
    if (q && e) return this.input.lastPress('KeyQ') >= this.input.lastPress('KeyE') ? 1 : -1;
    if (q) return 1;
    if (e) return -1;
    return 0;
  }

  private armStrikeActive(): boolean {
    for (const s of this.strikes.values()) if (!s.isLeg && s.phase !== 'retract') return true;
    return false;
  }

  // ───────── 사지 신전 ─────────
  private handleLimb(code: LimbKey, t: number, opp: FighterController): void {
    const limb = LIMB_BY_KEY[code];
    const keys = this.input.activeSet(t);
    const arm = !isLegLimb(limb);
    if (arm && matchesDoubleLeg(keys)) {
      this.startTakedown(t);
      return;
    }
    if (this.status !== 'normal' || this.takedown) return;
    if (arm && this.clinch) return; // 양손이 파지에 묶여 있음
    if (arm && this.input.isDown('Semicolon') && !keys.has('KeyQ') && !keys.has('KeyE') && !keys.has('KeyL') && !keys.has('KeyO')) {
      this.tryParry(limbSide(limb), opp);
      return;
    }
    const existing = this.strikes.get(limb);
    if (existing && existing.phase !== 'retract') return;
    this.launchStrike(limb, t, opp, keys);
  }

  private launchStrike(limb: LimbId, t: number, opp: FighterController, keys: Set<ControlKey>): void {
    const side = limbSide(limb);
    const isLeg = isLegLimb(limb);
    const chain = evaluateChain(this.input, t);
    const coreDir = this.resolveCoreDir(t);
    const groundPush = this.input.isActive('Space', t);
    const { mEff, factors } = effectiveMass({ groundPush, coreDir, limbSide: side });
    const flags: TrajectoryFlags = {
      horizontal: keys.has('KeyL'),
      vertical: keys.has('KeyO'),
      chamber: keys.has('Semicolon'),
      overTop: false,
    };
    const level: StrikeLevel = keys.has('ShiftLeft') ? (isLeg ? 'low' : 'mid') : isLeg ? 'mid' : 'high';
    const frameYaw = this.faceYaw;
    const curve = this.buildCurve(limb, flags, level, opp, frameYaw, null, 0);
    const prev = this.strikes.get(limb);
    const startLocal = prev?.localTarget ?? null;
    let duration = strikeDuration(limb, flags);
    if (!isLeg && (this.core.spinning || this.core.completing)) {
      // 스핀 중 팔 타격: 스핀을 마무리하도록 확정하고, 몸이 상대를 다시 마주보는 순간에 맞춰 휘두른다
      duration = clamp(commitSpin(this.core), duration, 0.6);
    }
    const strike: Strike = {
      id: strikeSeq++,
      limb, side, isLeg,
      startTime: t,
      duration,
      u: 0,
      phase: 'extend',
      phaseT: 0,
      frameYaw,
      level,
      curve,
      blendFrom: null,
      blendTo: null,
      blendT: 1,
      flags,
      shape: trajectoryShape(flags, isLeg),
      striker: strikerPart(limb, flags),
      chain,
      mEff,
      massFactors: factors,
      coreDir,
      groundPush,
      keys: new Set(keys),
      feintWindowKeys: new Set(),
      feints: [],
      rotationPeak: rotationDegrees(this.core),
      technique: TECHNIQUES.freeform,
      hasHit: false,
      localTarget: null,
      launchFrom: startLocal,
      prevTipLocal: null,
      limbPathPrev: null,
      vLimbLocal: ZERO,
      retractFrom: ZERO,
      tip: ZERO,
      impulse: 0,
    };
    strike.technique = this.classifyStrike(strike);
    this.strikes.set(limb, strike);
    this.energy.limbs[limb] = t;
    this.energy.grade = chain.grade;
    this.emit({ type: 'energy', fighter: this.name, stage: 'limb', limb, time: t });
    this.telemetry = this.strikeTelemetry(strike, false, null);
    this.emitTechnique(strike.technique, strike, this.telemetry, false);
    if (this.monitor.actionSpike(this.balance.ratio)) this.startStumble();
  }

  private classifyStrike(s: Strike): TechniqueResult {
    return classifyTechnique({
      action: 'strike',
      limb: s.limb,
      keys: s.keys,
      rotationDeg: s.rotationPeak,
      flags: s.flags,
      clinched: this.clinch !== null,
      feintWindowKeys: s.feintWindowKeys,
    });
  }

  /** 타겟 부위 선택 (상대 포즈 기준 월드 좌표) */
  private aimPoint(limb: LimbId, flags: TrajectoryFlags, level: StrikeLevel, opp: FighterController): Vec3 {
    const op = opp.pose;
    const ot = opp.torso;
    const isLeg = isLegLimb(limb);
    const body = add(op.lumbar, v3(0, 0.08, 0));
    if (isLeg) {
      if (this.clinch) return body;
      if (flags.overTop || (flags.vertical && !flags.chamber)) return op.head;
      if (flags.chamber) return op.lumbar;
      if (level === 'low') {
        const l = lerp(op.lHip, op.lKnee, 0.5);
        const r = lerp(op.rHip, op.rKnee, 0.5);
        return distance(l, this.pos) < distance(r, this.pos) ? l : r;
      }
      return body;
    }
    // 아래→위 궤적(어퍼컷)은 Shift 로 낮춘 자세에서 턱을 노린다
    if (flags.vertical && !flags.chamber) return add(op.head, v3(0, -0.06, 0));
    if (level === 'mid') {
      // 리버(간)는 상대의 오른쪽 옆구리 → 왼손 훅이 노리는 부위
      if (limb === 'leftArm' && flags.horizontal) return add(addScaled(op.lumbar, ot.chest.right, 0.11), v3(0, -0.02, 0));
      return body;
    }
    return op.head;
  }

  private buildCurve(
    limb: LimbId,
    flags: TrajectoryFlags,
    level: StrikeLevel,
    opp: FighterController,
    frameYaw: number,
    originLocal: Vec3 | null,
    lateralShift: number,
  ): BezierCurve {
    const basis = yawBasis(frameYaw);
    const origin = originLocal ?? toLocal(this.pos, basis, this.limbRoot(limb));
    let aim = toLocal(this.pos, basis, this.aimPoint(limb, flags, level, opp));
    if (lateralShift !== 0) aim = add(aim, v3(lateralShift, 0, 0));
    return buildTrajectory({ limb, origin, aim, flags });
  }

  // ───────── 페인트 ─────────
  private applyFeint(code: ControlKey, opp: FighterController): void {
    for (const s of this.strikes.values()) {
      if (s.phase !== 'extend' || s.u <= 0 || s.u > FEINT_U_MAX) continue;
      s.feints.push({ code, u: s.u });
      s.keys.add(code);
      if (s.u >= BRAZILIAN_U_MIN && s.u <= BRAZILIAN_U_MAX) s.feintWindowKeys.add(code);
      const nf: TrajectoryFlags = { ...s.flags };
      let lateral = 0;
      if (code === 'KeyL') {
        nf.horizontal = true;
        if (s.isLeg && s.u >= BRAZILIAN_U_MIN) nf.overTop = true;
      }
      if (code === 'KeyO') nf.vertical = true;
      if (code === 'Semicolon') nf.chamber = true;
      if (code === 'KeyQ' || code === 'KeyE') {
        s.coreDir = code === 'KeyQ' ? 1 : -1;
        const m = effectiveMass({ groundPush: s.groundPush, coreDir: s.coreDir, limbSide: s.side });
        s.mEff = m.mEff;
        s.massFactors = m.factors;
        // 뒤늦은 코어 회전은 사지 끝을 회전 방향으로 쓸어낸다
        lateral = -s.coreDir * 0.12;
      }
      s.flags = nf;
      s.blendFrom = s.curve;
      s.blendTo = this.buildCurve(s.limb, nf, s.level, opp, s.frameYaw, s.curve[0], lateral);
      s.blendT = 0;
      s.duration = Math.max(s.duration, strikeDuration(s.limb, nf));
      s.shape = trajectoryShape(nf, s.isLeg);
      s.striker = strikerPart(s.limb, nf);
      this.reclassify(s);
    }
  }

  private reclassify(s: Strike): void {
    const next = this.classifyStrike(s);
    if (next.id !== s.technique.id || next.name !== s.technique.name) {
      s.technique = next;
      this.telemetry = this.strikeTelemetry(s, false, null);
      this.emitTechnique(next, s, this.telemetry, true);
    }
  }

  private updateStrikes(dt: number): void {
    for (const [limb, s] of this.strikes) {
      if (s.blendFrom && s.blendTo) {
        s.blendT = Math.min(1, s.blendT + dt / FEINT_BLEND_TIME);
        s.curve = blendCurves(s.blendFrom, s.blendTo, s.blendT);
        if (s.blendT >= 1) s.blendFrom = s.blendTo = null;
      }
      if (s.phase === 'extend') {
        s.u = Math.min(1, s.u + dt / s.duration);
        const rot = rotationDegrees(this.core);
        if (Math.abs(rot) > Math.abs(s.rotationPeak)) {
          s.rotationPeak = rot;
          this.reclassify(s);
        }
        if (s.u >= 1) {
          s.phase = 'hold';
          s.phaseT = 0;
        }
      } else if (s.phase === 'hold') {
        s.phaseT += dt;
        if (s.phaseT >= HOLD_TIME) this.beginRetract(s);
      } else {
        s.phaseT += dt;
        if (s.phaseT >= (s.isLeg ? LEG_RETRACT : ARM_RETRACT)) {
          this.strikes.delete(limb);
          if (s.isLeg) this.feet.plant(s.side, footHome(this.pos, this.heading, s.side, this.duck));
        }
      }
    }
  }

  private beginRetract(s: Strike): void {
    s.phase = 'retract';
    s.phaseT = 0;
    s.retractFrom = s.localTarget ?? s.curve[3];
  }

  /** 적중 / 패링 / 피격으로 즉시 회수 */
  cancelStrike(limb: LimbId): void {
    const s = this.strikes.get(limb);
    if (s && s.phase !== 'retract') this.beginRetract(s);
  }

  private strikeRest(s: Strike, basis: ReturnType<typeof yawBasis>): Vec3 {
    if (s.isLeg) {
      const home = add(footHome(this.pos, this.heading, s.side, this.duck), v3(0, DIM.ankleHeight, 0));
      return toLocal(this.pos, basis, home);
    }
    return toLocal(this.pos, basis, guardHand(this.torso, s.side, this.input.isDown('Semicolon')));
  }

  /** 타격 IK 타겟 (월드). 신전 초반에는 휴식 자세에서 베지어 궤적으로 부드럽게 진입 */
  private strikeTarget(s: Strike, dt: number): Vec3 {
    const basis = yawBasis(s.frameYaw);
    const rest = this.strikeRest(s, basis);
    let local: Vec3;
    if (s.phase === 'retract') {
      const k = smoothstep(0, 1, s.phaseT / (s.isLeg ? LEG_RETRACT : ARM_RETRACT));
      local = lerp(s.retractFrom, rest, k);
      if (s.isLeg) local = add(local, v3(0, Math.sin(Math.PI * k) * 0.08, 0));
      s.vLimbLocal = ZERO;
      s.limbPathPrev = null;
    } else {
      const p = bezierPoint(s.curve, s.u);
      const start = s.launchFrom ?? rest;
      // 접힌 사지(팔꿈치/무릎)는 짧은 궤적 전체에 걸쳐 휴식 자세에서 진입해야 타격점이 끝까지 가속된다
      const w = s.flags.chamber ? smoothstep(0, 1, s.u) : smoothstep(0, 0.3, s.u);
      // 사지 자체의 신전 경로 (v_limb 측정용, 몸통 회전 성분 제외)
      const limbPath = lerp(start, p, w);
      if (!s.flags.chamber) {
        s.vLimbLocal = s.limbPathPrev ? scale(sub(limbPath, s.limbPathPrev), 1 / dt) : ZERO;
      }
      s.limbPathPrev = limbPath;
      // 궤적은 실제 어깨/고관절에 붙어 이동 → 코어 회전이 도달 거리에 반영된다
      const jointNow = toLocal(this.pos, basis, this.limbRoot(s.limb));
      local = add(limbPath, scale(sub(jointNow, s.curve[0]), w));
    }
    s.localTarget = local;
    return toWorld(this.pos, basis, local);
  }

  private limbRoot(limb: LimbId): Vec3 {
    const t = this.torso;
    return limb === 'leftArm' ? t.lShoulder : limb === 'rightArm' ? t.rShoulder : limb === 'leftLeg' ? t.lHip : t.rHip;
  }

  private strikePole(s: Strike): Vec3 {
    const t = this.torso;
    const out = scale(t.chest.right, s.side === 'left' ? -1 : 1);
    if (s.isLeg) {
      if (s.flags.horizontal || s.flags.overTop) return normalize(add(scale(out, 0.8), v3(0, 0.6, 0)));
      if (s.flags.chamber) return normalize(add(t.hips.forward, v3(0, 0.8, 0)));
      return normalize(add(t.hips.forward, v3(0, 0.3, 0)));
    }
    if (s.flags.chamber) return normalize(add(add(scale(out, 0.6), v3(0, 0.6, 0)), scale(t.chest.forward, 0.3)));
    if (s.flags.horizontal) return normalize(add(out, v3(0, 0.45, 0)));
    return defaultElbowPole(t, s.side);
  }

  // ───────── 패링 / 파지 / 테이크다운 ─────────
  private tryParry(side: Side, opp: FighterController): void {
    this.parryAnim = { side, t: 0, dur: 0.14 };
    let parried: Strike | null = null;
    for (const s of opp.strikes.values()) {
      if (s.phase !== 'extend' || s.hasHit || s.u < 0.3) continue;
      const dHead = distance(s.tip, this.pose.head);
      const dChest = distance(s.tip, this.pose.thorax);
      if (Math.min(dHead, dChest) < 0.6) {
        parried = s;
        break;
      }
    }
    if (parried) {
      opp.cancelStrike(parried.limb);
      opp.setStatus('hitstun', PARRY_STUN);
      this.emit({ type: 'parry', fighter: this.name, point: parried.tip });
      this.emitTechnique(TECHNIQUES.parry, null, null, false);
    } else {
      this.emitTechnique(TECHNIQUES.guard, null, null, false);
    }
  }

  private handleGrab(t: number, opp: FighterController): void {
    const keys = this.input.activeSet(t);
    if (matchesDoubleLeg(keys)) {
      this.startTakedown(t);
      return;
    }
    if (this.status !== 'normal' || this.takedown || this.clinch || opp.downed) return;
    const d = distanceXZ(this.torso.thorax, opp.torso.thorax);
    let part: GrabPart | null = null;
    let wristSide: Side | null = null;
    for (const s of opp.strikes.values()) {
      if (s.isLeg || s.phase === 'retract') continue;
      if (Math.min(distance(s.tip, this.pose.thorax), distance(s.tip, this.pose.head)) < 0.55) {
        part = 'wrist';
        wristSide = s.side;
        break;
      }
    }
    if (!part) {
      if (keys.has('ShiftLeft') && d < 0.85) part = 'leg';
      else if (d < 0.8) part = 'neck';
    }
    this.emitTechnique(TECHNIQUES.grab, null, null, false);
    if (!part) {
      this.grabMiss = { t: 0, dur: 0.3 };
      this.emit({ type: 'grab', fighter: this.name, part: 'miss' });
      return;
    }
    for (const limb of ['leftArm', 'rightArm'] as LimbId[]) this.strikes.delete(limb);
    if (part === 'wrist' && wristSide) {
      opp.cancelStrike(wristSide === 'left' ? 'leftArm' : 'rightArm');
      opp.heldWrist = { side: wristSide, by: this };
    }
    this.clinch = { part, wristSide, since: t };
    opp.clinchedBy = this;
    this.emit({ type: 'grab', fighter: this.name, part });
  }

  releaseClinch(): void {
    if (!this.clinch) return;
    this.clinch = null;
    // 상대 쪽 참조는 updateClinch 에서 정리
  }

  private updateClinch(dt: number, opp: FighterController): void {
    if (opp.clinchedBy === this && !this.clinch) opp.clinchedBy = null;
    if (opp.heldWrist?.by === this && (!this.clinch || this.clinch.part !== 'wrist')) opp.heldWrist = null;
    if (!this.clinch) return;
    const d = distanceXZ(this.pos, opp.pos);
    if (!this.input.isDown('KeyM') || !this.actionable || opp.downed || d > 1.15) {
      this.releaseClinch();
      opp.clinchedBy = null;
      if (opp.heldWrist?.by === this) opp.heldWrist = null;
      return;
    }
    if (this.clinch.part !== 'wrist') {
      // 목/하체 파지: 상대를 가까이 끌어당김
      const desired = 0.55;
      const dir = normalize(flatXZ(sub(opp.pos, this.pos)));
      const goal = addScaled(this.pos, dir, desired);
      opp.pos = lerp(opp.pos, v3(goal.x, opp.pos.y, goal.z), 1 - Math.exp(-6 * dt));
    }
  }

  private startTakedown(t: number): void {
    if (this.status !== 'normal' || this.takedown) return;
    for (const limb of ['leftArm', 'rightArm'] as LimbId[]) this.strikes.delete(limb);
    const chain = evaluateChain(this.input, t);
    const { mEff, factors } = effectiveMass({ groundPush: this.input.isActive('Space', t), coreDir: 0, limbSide: 'right' });
    this.takedown = { t: 0, dur: 0.55, chain, mEff, massFactors: factors, resolved: false };
    this.impulseVel = addScaled(this.impulseVel, yawBasis(this.faceYaw).forward, 1.4);
    this.energy.limbs.leftArm = this.energy.limbs.rightArm = t;
    this.energy.grade = chain.grade;
    this.emit({ type: 'energy', fighter: this.name, stage: 'limb', limb: null, time: t });
    const tele = this.takedownTelemetry(0, false);
    this.telemetry = tele;
    this.emitTechnique(TECHNIQUES.doubleLegTakedown, null, tele, false);
  }

  private updateTakedown(dt: number, opp: FighterController): void {
    const td = this.takedown;
    if (!td) return;
    td.t += dt;
    if (!td.resolved && td.t >= 0.25) {
      td.resolved = true;
      const success = distanceXZ(this.pos, opp.pos) < 1.0 && !opp.downed;
      let impulse = 0;
      if (success) {
        impulse = computeImpact({
          eta: td.chain.eta, mEff: td.mEff, vStep: this.velocity, omegaCore: 0, rJoint: ZERO, vLimb: ZERO,
        }).impulse;
        opp.applyTakedown(impulse, this);
        this.releaseClinch();
        opp.clinchedBy = null;
      }
      this.telemetry = this.takedownTelemetry(impulse, success);
      this.emit({ type: 'takedown', fighter: this.name, success, impulse });
    }
    if (td.t >= td.dur) this.takedown = null;
  }

  // ───────── 피격 ─────────
  /** CombatSystem 이 호출. 반환값으로 데미지/가드/카운터 결과를 돌려준다 */
  receiveHit(impulse: number, zone: HitZone, dir: Vec3): { damage: number; blocked: boolean; counter: boolean } {
    const fwd = yawBasis(this.faceYaw).forward;
    // 셸 가드는 정면(±70°)에서 들어오는 상단/몸통 타격을 막는다
    const blocked = this.guardUp && zone !== 'leg' && dot(normalize(flatXZ(dir)), fwd) < -0.34;
    let damage = impulse * DAMAGE_SCALE * ZONE_MULTIPLIER[zone];
    if (blocked) damage *= GUARD_DAMAGE_FACTOR;
    const counter = !blocked && this.status === 'stumble';
    if (this.hasHp) this.hp = Math.max(0, this.hp - damage);
    this.knockVel = addScaled(this.knockVel, normalize(flatXZ(dir)), Math.min(impulse * 0.05, 2.5) * (blocked ? 0.4 : 1));
    this.hitFlash = this.now;
    if (this.hasHp && this.hp <= 0) {
      this.goDown('ko');
    } else if (counter) {
      this.goDown('knockdown');
      this.emit({ type: 'knockdown', fighter: this.name, reason: 'counter' });
    } else if (!blocked) {
      this.setStatus('hitstun', 0.18 + Math.min(impulse, 20) * 0.01);
      if (impulse > 6) for (const l of this.strikes.keys()) this.cancelStrike(l);
    }
    return { damage, blocked, counter };
  }

  applyTakedown(impulse: number, by: FighterController): void {
    const damage = impulse * DAMAGE_SCALE * ZONE_MULTIPLIER.body;
    if (this.hasHp) this.hp = Math.max(0, this.hp - damage);
    this.knockVel = addScaled(this.knockVel, yawBasis(by.faceYaw).forward, 1.2);
    this.hitFlash = this.now;
    if (this.hasHp && this.hp <= 0) {
      this.goDown('ko');
    } else {
      this.goDown('knockdown', TAKEDOWN_KNOCKDOWN_TIME);
      this.emit({ type: 'knockdown', fighter: this.name, reason: 'takedown' });
    }
  }

  setStatus(s: FighterStatus, dur: number): void {
    if (this.downed && s !== 'normal') return;
    if (s === 'hitstun' && this.status === 'stumble') return;
    this.status = s;
    this.statusT = 0;
    this.statusDur = dur;
  }

  private startStumble(): void {
    if (this.downed) return;
    this.setStatus('stumble', STUMBLE_DURATION);
    for (const l of this.strikes.keys()) this.cancelStrike(l);
    this.takedown = null;
    this.releaseClinch();
    this.emit({ type: 'stumble', fighter: this.name });
  }

  private goDown(kind: 'knockdown' | 'ko', dur = KNOCKDOWN_TIME): void {
    this.status = kind;
    this.statusT = 0;
    this.statusDur = kind === 'ko' ? KO_TIME : dur;
    this.strikes.clear();
    this.takedown = null;
    this.releaseClinch();
    this.monitor.reset();
    if (kind === 'ko') this.emit({ type: 'ko', fighter: this.name });
  }

  private updateStatus(dt: number): void {
    const downTarget = this.downed ? 1 : 0;
    this.fall = clamp(this.fall + (downTarget - this.fall) * (1 - Math.exp(-(this.downed ? 7 : 4) * dt)), 0, 1);
    this.wobble = this.status === 'stumble' ? Math.sin(this.statusT * 22) * 0.18 * (1 - this.statusT / this.statusDur) : 0;
    if (this.status === 'normal') return;
    this.statusT += dt;
    if (this.statusT >= this.statusDur) {
      if (this.status === 'ko' && this.hasHp) this.hp = MAX_HP;
      const wasDown = this.downed;
      this.status = 'normal';
      this.statusT = 0;
      if (wasDown) {
        this.feet.reset(this.pos, this.heading);
        this.emit({ type: 'recover', fighter: this.name });
      }
    }
  }

  // ───────── 보법 ─────────
  private updateLocomotion(dt: number): void {
    let speed = STEP_SPEED * (1 - this.duck * 0.4);
    if (this.status === 'stumble' || this.downed) speed = 0;
    if (this.clinchedBy) speed *= 0.35;
    const desired = this.actionable || this.status === 'stumble' ? scale(this.moveInputDir(), speed) : ZERO;
    this.moveVel = lerp(this.moveVel, desired, 1 - Math.exp(-14 * dt));
    this.impulseVel = scale(this.impulseVel, Math.exp(-IMPULSE_DECAY * dt));
    this.knockVel = scale(this.knockVel, Math.exp(-6 * dt));
    this.pos = flatXZ(addScaled(this.pos, this.velocity, dt));
    if (this.anchor) this.pos = lerp(this.pos, this.anchor, 1 - Math.exp(-1.2 * dt));
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > RING_RADIUS) this.pos = scale(this.pos, RING_RADIUS / r);
  }

  // ───────── 포즈 / 밸런스 ─────────
  private solveBody(dt: number, opp: FighterController | null): void {
    const kicking: Record<Side, boolean> = { left: this.strikes.has('leftLeg'), right: this.strikes.has('rightLeg') };
    const heading = this.heading;

    // 체중 이동: 킥 중에는 디딤발 위로, 뒷발 중심 이동(Ctrl) 시 뒷발 위로
    let shiftTarget: Vec3 = ZERO;
    if (kicking.left !== kicking.right) {
      const support = this.feet.planted(kicking.left ? 'right' : 'left');
      shiftTarget = scale(flatXZ(sub(support, this.pos)), 0.8);
    } else if (this.lean > 0.01) {
      shiftTarget = scale(flatXZ(sub(this.feet.planted('right'), this.pos)), 0.55 * this.lean);
    }
    this.pelvisShift = lerp(this.pelvisShift, shiftTarget, 1 - Math.exp(-12 * dt));

    let pitchTarget = 0;
    for (const s of this.strikes.values()) {
      if (s.phase === 'retract') continue;
      const w = smoothstep(0, 0.6, s.u);
      pitchTarget += s.isLeg ? -0.12 * w : 0.1 * w;
    }
    if (this.takedown) pitchTarget += 0.35;
    this.strikePitch = lerpNum(this.strikePitch, pitchTarget, 1 - Math.exp(-14 * dt));

    this.torso = computeTorso({
      pos: this.pos,
      heading,
      coreYaw: this.core.yaw,
      duck: this.duck,
      lean: this.lean,
      strikePitch: this.strikePitch,
      fall: this.fall,
      pelvisShift: this.pelvisShift,
      wobble: this.wobble,
    });
    const t = this.torso;

    const homes = { left: footHome(this.pos, heading, 'left', this.duck), right: footHome(this.pos, heading, 'right', this.duck) };
    const light: Side | null = this.lean > 0.6 && !kicking.right ? 'left' : null;
    const feetOut = this.feet.update(dt, homes, this.velocity, kicking, light);

    const shell = this.input.isDown('Semicolon') && this.actionable;
    let lHand = guardHand(t, 'left', shell);
    let rHand = guardHand(t, 'right', shell);
    let lElbowPole = defaultElbowPole(t, 'left');
    let rElbowPole = defaultElbowPole(t, 'right');
    let lFoot = feetOut.left;
    let rFoot = feetOut.right;
    let lKneePole = defaultKneePole(t, 'left');
    let rKneePole = defaultKneePole(t, 'right');

    if (this.downed) {
      // 넘어진 상태: 팔을 몸 옆으로
      lHand = toWorld(t.thorax, t.chest, v3(-0.35, -0.25, 0.1));
      rHand = toWorld(t.thorax, t.chest, v3(0.35, -0.25, 0.1));
    }

    if (this.parryAnim) {
      const k = Math.sin((Math.PI * this.parryAnim.t) / this.parryAnim.dur);
      const base = guardHand(t, this.parryAnim.side, true);
      const p = addScaled(base, t.chest.forward, 0.2 * k);
      if (this.parryAnim.side === 'left') lHand = p;
      else rHand = p;
    }
    if (this.grabMiss) {
      const k = Math.sin((Math.PI * this.grabMiss.t) / this.grabMiss.dur);
      lHand = addScaled(lHand, t.chest.forward, 0.35 * k);
      rHand = addScaled(rHand, t.chest.forward, 0.35 * k);
    }
    if (opp && this.clinch) {
      const op = opp.pose;
      const oc = opp.torso.chest;
      if (this.clinch.part === 'neck') {
        const neck = add(op.head, v3(0, -0.13, 0));
        lHand = addScaled(neck, oc.right, 0.07);
        rHand = addScaled(neck, oc.right, -0.07);
      } else if (this.clinch.part === 'leg') {
        lHand = lerp(op.lHip, op.lKnee, 0.6);
        rHand = lerp(op.rHip, op.rKnee, 0.6);
      } else {
        const w = this.clinch.wristSide === 'left' ? op.lWrist : op.rWrist;
        lHand = w;
      }
    }
    if (opp && this.takedown) {
      const k = smoothstep(0, 0.25, this.takedown.t);
      lHand = lerp(lHand, lerp(opp.pose.rHip, opp.pose.rKnee, 0.5), k);
      rHand = lerp(rHand, lerp(opp.pose.lHip, opp.pose.lKnee, 0.5), k);
    }
    if (this.heldWrist) {
      const holder = this.heldWrist.by.pose;
      if (this.heldWrist.side === 'left') lHand = holder.lWrist;
      else rHand = holder.lWrist;
    }

    for (const s of this.strikes.values()) {
      const target = this.strikeTarget(s, dt);
      const pole = this.strikePole(s);
      if (s.limb === 'leftArm') { lHand = target; lElbowPole = pole; }
      else if (s.limb === 'rightArm') { rHand = target; rElbowPole = pole; }
      else if (s.limb === 'leftLeg') { lFoot = target; lKneePole = pole; }
      else { rFoot = target; rKneePole = pole; }
    }

    this.pose = solvePose(t, { lHand, rHand, lElbowPole, rElbowPole, lFoot, rFoot, lKneePole, rKneePole });
    for (const s of this.strikes.values()) {
      s.tip = this.strikerPoint(s.limb, s.striker);
      // 팔꿈치/무릎 타격은 IK 타겟(손/발)이 아니라 타격점 자체의 신전 속도를 v_limb 로 쓴다
      if (s.flags.chamber && s.phase !== 'retract' && dt > 0) {
        const b = yawBasis(s.frameYaw);
        const tl = sub(toLocal(this.pos, b, s.tip), toLocal(this.pos, b, this.limbRoot(s.limb)));
        s.vLimbLocal = s.prevTipLocal ? scale(sub(tl, s.prevTipLocal), 1 / dt) : ZERO;
        s.prevTipLocal = tl;
      }
    }

    this.supportFeet = [];
    if (feetOut.leftSupport) this.supportFeet.push(this.pose.lAnkle);
    if (feetOut.rightSupport) this.supportFeet.push(this.pose.rAnkle);
  }

  strikerPoint(limb: LimbId, part: StrikerPart): Vec3 {
    const p = this.pose;
    switch (part) {
      case 'fist': return fistPoint(p, limb === 'leftArm' ? 'left' : 'right');
      case 'elbow': return limb === 'leftArm' ? p.lElbow : p.rElbow;
      case 'knee': return limb === 'leftLeg' ? p.lKnee : p.rKnee;
      case 'foot': return limb === 'leftLeg' ? p.lAnkle : p.rAnkle;
    }
  }

  private updateBalance(dt: number): void {
    this.balance = evaluateBalance({
      pose: this.pose,
      supportFeet: this.supportFeet,
      rootVel: this.velocity,
      coreOmega: currentOmega(this.core),
      torsoForward: this.torso.chest.forward,
    });
    if (this.downed) {
      this.monitor.reset();
      return;
    }
    // 테이크다운 돌진은 의도된 체중 투입이므로 스트레스로 보지 않는다 (발사 순간의 급증 판정만 적용)
    let striking = false;
    for (const s of this.strikes.values()) if (s.phase !== 'retract') striking = true;
    const stressed = Math.abs(currentOmega(this.core)) > 3 || striking;
    if (this.actionable && this.monitor.update(this.balance.ratio, stressed, dt)) this.startStumble();
  }

  // ───────── 텔레메트리 ─────────
  /** 현재 상태 기준 I_impact (적중 순간에 CombatSystem 이 그대로 사용) */
  impactFor(s: Strike): { impulse: number; vRot: number; vLimb: number; omega: number; vSum: Vec3 } {
    const joint = this.limbRoot(s.limb);
    const center = s.isLeg ? this.torso.pelvis : this.torso.thorax;
    const omega = peakOmega(this.core);
    const vLimb = dirToWorld(yawBasis(s.frameYaw), s.vLimbLocal);
    const r = computeImpact({ eta: s.chain.eta, mEff: s.mEff, vStep: this.velocity, omegaCore: omega, rJoint: sub(joint, center), vLimb });
    return { impulse: r.impulse, vRot: length(r.vRot), vLimb: length(vLimb), omega, vSum: r.vSum };
  }

  strikeTelemetry(s: Strike, final: boolean, zone: HitZone | null): ChainTelemetry {
    const imp = this.impactFor(s);
    return {
      limb: s.limb,
      technique: s.technique,
      chain: s.chain,
      mEff: s.mEff,
      massFactors: s.massFactors,
      vStep: length(this.velocity),
      vRot: imp.vRot,
      omega: imp.omega,
      vLimb: imp.vLimb,
      impulse: final ? s.impulse : imp.impulse,
      shape: s.shape,
      striker: s.striker,
      final,
      zone,
      time: this.now,
    };
  }

  private takedownTelemetry(impulse: number, final: boolean): ChainTelemetry {
    const td = this.takedown!;
    return {
      limb: null,
      technique: TECHNIQUES.doubleLegTakedown,
      chain: td.chain,
      mEff: td.mEff,
      massFactors: td.massFactors,
      vStep: length(this.velocity),
      vRot: 0,
      omega: 0,
      vLimb: 0,
      impulse,
      shape: 'straight',
      striker: 'fist',
      final,
      zone: final ? 'leg' : null,
      time: this.now,
    };
  }

  private updateLiveTelemetry(): void {
    if (this.telemetry?.final) return;
    let latest: Strike | null = null;
    for (const s of this.strikes.values()) {
      if (s.phase === 'retract' || s.hasHit) continue;
      if (!latest || s.startTime > latest.startTime) latest = s;
    }
    if (latest) {
      const tele = this.strikeTelemetry(latest, false, null);
      // 신전 중 최대값을 유지해 HUD 에 의미 있는 예상 충격량을 보여준다
      if (this.telemetry && !this.telemetry.final && this.telemetry.limb === latest.limb) {
        tele.impulse = Math.max(tele.impulse, this.telemetry.impulse);
      }
      this.telemetry = tele;
    }
  }

  // ───────── 이벤트 ─────────
  private emit(e: WorldEvent): void {
    this.events.push(e);
  }

  private emitTechnique(tech: TechniqueResult, s: Strike | null, tele: ChainTelemetry | null, updated: boolean): void {
    const telemetry: ChainTelemetry = tele ?? {
      limb: s?.limb ?? null,
      technique: tech,
      chain: { grade: 'isolated', eta: 1, dt1: null, dt2: null, tGround: null, tCore: null, tLimb: this.now },
      mEff: 1,
      massFactors: [],
      vStep: length(this.velocity),
      vRot: 0,
      omega: 0,
      vLimb: 0,
      impulse: 0,
      shape: 'straight',
      striker: 'fist',
      final: false,
      zone: null,
      time: this.now,
    };
    this.emit({ type: 'technique', fighter: this.name, technique: tech, telemetry, updated });
  }

  drainEvents(): WorldEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
