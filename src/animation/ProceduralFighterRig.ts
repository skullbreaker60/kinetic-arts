// 절차적 다관절 파이터 리그: 몸통 FK + 사지 2-Bone IK + 발 디딤(Foot Planting)
// 엔진 독립 포즈 솔버 — 결과(관절 월드 좌표)는 SceneRenderer 가 Three.js 로 그린다.
import { solveTwoBoneIK } from '../core/ik';
import {
  Basis, Vec3, add, addScaled, bodyBasis, distanceXZ, flatXZ, lerp, normalize, scale, sub, toWorld, v3, yawBasis,
} from '../core/math';
import type { Pose, Side } from '../types/combat';

export const DIM = {
  pelvisHeight: 0.97,
  duckDrop: 0.3,
  lumbar: 0.13,
  thorax: 0.27,
  neck: 0.24,
  shoulderHalf: 0.19,
  shoulderUp: 0.05,
  hipHalf: 0.1,
  hipDown: 0.05,
  upperArm: 0.3,
  forearm: 0.28,
  thigh: 0.45,
  shin: 0.45,
  ankleHeight: 0.07,
} as const;

export interface TorsoParams {
  pos: Vec3; // 루트 (지면)
  heading: number; // 하체 기준 요
  coreYaw: number; // 코어 비틀림
  duck: number; // 0..1 (ShiftLeft)
  lean: number; // 0..1 (ControlLeft, 뒤로)
  strikePitch: number; // 타격 중 상체 피치
  fall: number; // 0..1 (다운)
  pelvisShift: Vec3; // 체중 이동 (월드 XZ)
  wobble: number; // 비틀거림 흔들림 (rad)
}

export interface TorsoFrame {
  pelvis: Vec3;
  lumbar: Vec3;
  thorax: Vec3;
  head: Vec3;
  lShoulder: Vec3;
  rShoulder: Vec3;
  lHip: Vec3;
  rHip: Vec3;
  chest: Basis;
  hips: Basis;
}

export function computeTorso(p: TorsoParams): TorsoFrame {
  const base = yawBasis(p.heading);
  const pelvisY = DIM.pelvisHeight - p.duck * DIM.duckDrop - p.fall * 0.8;
  const pelvis = add(add(add(p.pos, flatXZ(p.pelvisShift)), scale(base.forward, -p.lean * 0.1)), v3(0, pelvisY, 0));
  const pitch = p.duck * 0.22 - p.lean * 0.22 + p.strikePitch - p.fall * 1.35;
  const hips = bodyBasis(p.heading + p.coreYaw * 0.55 + p.wobble * 0.5, pitch * 0.4);
  const chest = bodyBasis(p.heading + p.coreYaw + p.wobble, pitch);
  const lumbar = addScaled(pelvis, hips.up, DIM.lumbar);
  const thorax = addScaled(lumbar, chest.up, DIM.thorax);
  const head = add(addScaled(thorax, chest.up, DIM.neck), scale(chest.forward, 0.02));
  const shoulder = (s: number) => toWorld(thorax, chest, v3(s * DIM.shoulderHalf, DIM.shoulderUp, 0));
  const hip = (s: number) => toWorld(pelvis, hips, v3(s * DIM.hipHalf, -DIM.hipDown, 0));
  return {
    pelvis, lumbar, thorax, head,
    lShoulder: shoulder(-1), rShoulder: shoulder(1),
    lHip: hip(-1), rHip: hip(1),
    chest, hips,
  };
}

/** 가드 자세 손 위치 (흉추 기저 로컬). shell = ; 액티브 셸 가드 */
export function guardHand(t: TorsoFrame, side: Side, shell: boolean): Vec3 {
  const s = side === 'left' ? -1 : 1;
  if (shell) return toWorld(t.thorax, t.chest, v3(s * 0.08, 0.27, 0.17));
  return side === 'left'
    ? toWorld(t.thorax, t.chest, v3(-0.13, 0.18, 0.26))
    : toWorld(t.thorax, t.chest, v3(0.12, 0.2, 0.16));
}

export function defaultElbowPole(t: TorsoFrame, side: Side): Vec3 {
  const s = side === 'left' ? -1 : 1;
  return normalize(add(add(scale(t.chest.up, -1), scale(t.chest.right, s * 0.6)), scale(t.chest.forward, -0.3)));
}

export function defaultKneePole(t: TorsoFrame, side: Side): Vec3 {
  const s = side === 'left' ? -1 : 1;
  return normalize(add(t.hips.forward, scale(t.hips.right, s * 0.25)));
}

/** 오소독스 스탠스 발 기본 위치 (하체 기저 로컬) */
export function footHome(pos: Vec3, heading: number, side: Side, duck: number): Vec3 {
  const b = yawBasis(heading);
  const widen = 1 + duck * 0.25;
  const local = side === 'left' ? v3(-0.13 * widen, 0, 0.2 * widen) : v3(0.13 * widen, 0, -0.2 * widen);
  return toWorld(pos, b, local);
}

// ───────── 발 디딤 계획 ─────────
interface FootState {
  planted: Vec3; // 지면 위치 (y = 0)
  stepping: boolean;
  from: Vec3;
  to: Vec3;
  t: number;
  dur: number;
}

export interface FootOutput {
  left: Vec3; // 발목 IK 타겟
  right: Vec3;
  leftSupport: boolean;
  rightSupport: boolean;
}

const STEP_TRIGGER = 0.11;
const STEP_DURATION = 0.13;
const STEP_HEIGHT = 0.06;

export class FootPlanner {
  private feet: Record<Side, FootState>;

  constructor(pos: Vec3, heading: number) {
    const mk = (side: Side): FootState => {
      const h = footHome(pos, heading, side, 0);
      return { planted: h, stepping: false, from: h, to: h, t: 0, dur: STEP_DURATION };
    };
    this.feet = { left: mk('left'), right: mk('right') };
  }

  reset(pos: Vec3, heading: number): void {
    for (const side of ['left', 'right'] as Side[]) {
      const h = footHome(pos, heading, side, 0);
      this.feet[side] = { planted: h, stepping: false, from: h, to: h, t: 0, dur: STEP_DURATION };
    }
  }

  /** 차는 발이 착지할 때 호출 */
  plant(side: Side, at: Vec3): void {
    const f = this.feet[side];
    f.planted = flatXZ(at);
    f.stepping = false;
  }

  planted(side: Side): Vec3 {
    return this.feet[side].planted;
  }

  /**
   * kicking: 타격 중인 다리 (발 위치는 궤적이 제어). lightFoot: 체중이 빠져 살짝 든 발.
   */
  update(
    dt: number,
    homes: Record<Side, Vec3>,
    vel: Vec3,
    kicking: Record<Side, boolean>,
    lightFoot: Side | null,
  ): FootOutput {
    for (const side of ['left', 'right'] as Side[]) {
      const f = this.feet[side];
      if (f.stepping) {
        f.t += dt;
        if (f.t >= f.dur) {
          f.stepping = false;
          f.planted = f.to;
        }
      }
    }
    // 한 번에 한 발만 디딘다 (오차가 큰 발 우선)
    const anyStepping = this.feet.left.stepping || this.feet.right.stepping;
    if (!anyStepping) {
      let pick: Side | null = null;
      let worst = STEP_TRIGGER;
      for (const side of ['left', 'right'] as Side[]) {
        if (kicking[side] || kicking[side === 'left' ? 'right' : 'left']) continue;
        const err = distanceXZ(this.feet[side].planted, homes[side]);
        if (err > worst) {
          worst = err;
          pick = side;
        }
      }
      if (pick) {
        const f = this.feet[pick];
        f.stepping = true;
        f.from = f.planted;
        f.to = flatXZ(addScaled(homes[pick], vel, 0.1));
        f.t = 0;
        f.dur = STEP_DURATION;
      }
    }
    const out = (side: Side): Vec3 => {
      const f = this.feet[side];
      let p: Vec3;
      if (f.stepping) {
        const k = f.t / f.dur;
        p = add(lerp(f.from, f.to, k), v3(0, Math.sin(Math.PI * k) * STEP_HEIGHT, 0));
      } else {
        p = f.planted;
      }
      const lift = lightFoot === side ? 0.035 : 0;
      return add(p, v3(0, DIM.ankleHeight + lift, 0));
    };
    return {
      left: out('left'),
      right: out('right'),
      leftSupport: !kicking.left && lightFoot !== 'left',
      rightSupport: !kicking.right && lightFoot !== 'right',
    };
  }
}

// ───────── 전신 포즈 ─────────
export interface LimbTargets {
  lHand: Vec3;
  rHand: Vec3;
  lElbowPole: Vec3;
  rElbowPole: Vec3;
  lFoot: Vec3;
  rFoot: Vec3;
  lKneePole: Vec3;
  rKneePole: Vec3;
}

export function solvePose(t: TorsoFrame, g: LimbTargets): Pose {
  const la = solveTwoBoneIK(t.lShoulder, g.lHand, DIM.upperArm, DIM.forearm, g.lElbowPole);
  const ra = solveTwoBoneIK(t.rShoulder, g.rHand, DIM.upperArm, DIM.forearm, g.rElbowPole);
  const ll = solveTwoBoneIK(t.lHip, g.lFoot, DIM.thigh, DIM.shin, g.lKneePole);
  const rl = solveTwoBoneIK(t.rHip, g.rFoot, DIM.thigh, DIM.shin, g.rKneePole);
  return {
    pelvis: t.pelvis,
    lumbar: t.lumbar,
    thorax: t.thorax,
    head: t.head,
    lShoulder: t.lShoulder,
    lElbow: la.mid,
    lWrist: la.end,
    rShoulder: t.rShoulder,
    rElbow: ra.mid,
    rWrist: ra.end,
    lHip: t.lHip,
    lKnee: ll.mid,
    lAnkle: ll.end,
    rHip: t.rHip,
    rKnee: rl.mid,
    rAnkle: rl.end,
  };
}

/** 주먹 중심 = 손목에서 전완 방향으로 조금 더 나간 점 */
export function fistPoint(pose: Pose, side: Side): Vec3 {
  const e = side === 'left' ? pose.lElbow : pose.rElbow;
  const w = side === 'left' ? pose.lWrist : pose.rWrist;
  return addScaled(w, normalize(sub(w, e)), 0.05);
}
