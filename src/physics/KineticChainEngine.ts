// 운동 사슬 물리: 지면 반발 / 코어 회전 스프링 / 유효 질량 / 충격량 I_impact (명세 3.2)
import { Vec3, add, cross, length, springStep, v3 } from '../core/math';
import type { MassFactor, Side } from '../types/combat';

// ───────── 상수 ─────────
export const STEP_SPEED = 1.7; // m/s, WASD 보법
export const GROUND_IMPULSE = 3.2; // m/s, Space 지면 반발 임펄스로 얻는 속도
export const IMPULSE_DECAY = 5.0; // 1/s
export const CORE_NEUTRAL = -0.3; // rad, 오소독스 스탠스(왼어깨 전방) 기본 비틀림
export const CORE_CCW = 0.8; // KeyQ: 오른쪽 어깨/고관절 전방 투입
export const CORE_CW = -1.05; // KeyE: 왼쪽 어깨/고관절 전방 투입
export const CORE_OMEGA_N = 22;
export const CORE_ZETA = 0.72;
export const SPIN_RATE = 11; // rad/s, 코어 한계 도달 후 몸 전체 회전
export const SPIN_HOLD = 0.22; // s, Q/E 를 이만큼 유지하면 스핀 돌입
/** ω_core 로 사용할 최근 피크 구간 (코어 → 사지 에너지 전달) */
export const OMEGA_PEAK_WINDOW = 0.25;

// ───────── 유효 질량 m_eff ─────────
export interface MassContext {
  groundPush: boolean; // Space 지면 반발 투입
  coreDir: -1 | 0 | 1; // +1 = KeyQ(좌회전), -1 = KeyE(우회전), 0 = 회전 없음
  limbSide: Side;
}

/**
 * 기본 1.0, Space ×1.4, 회전 방향 일치 ×1.3, 역회전 ×0.6
 * 일치 규칙: KeyQ(좌회전) → 오른쪽 사지, KeyE(우회전) → 왼쪽 사지
 */
export function effectiveMass(ctx: MassContext): { mEff: number; factors: MassFactor[] } {
  const factors: MassFactor[] = [{ label: '기본', value: 1.0 }];
  let m = 1.0;
  if (ctx.groundPush) {
    m *= 1.4;
    factors.push({ label: '지면 반발', value: 1.4 });
  }
  if (ctx.coreDir !== 0) {
    const matching = (ctx.coreDir === 1 && ctx.limbSide === 'right') || (ctx.coreDir === -1 && ctx.limbSide === 'left');
    const f = matching ? 1.3 : 0.6;
    m *= f;
    factors.push({ label: matching ? '회전 일치' : '역회전', value: f });
  }
  return { mEff: m, factors };
}

// ───────── 충격량 ─────────
export interface ImpactInput {
  eta: number;
  mEff: number;
  vStep: Vec3; // 캐릭터 중심 이동 속도
  omegaCore: number; // y축 각속도 (rad/s)
  rJoint: Vec3; // 척추 중심 → 어깨/고관절
  vLimb: Vec3; // 사지 자체 신전 속도
}

export interface ImpactResult {
  impulse: number;
  vRot: Vec3; // ω × r
  vSum: Vec3;
}

/** I = η · m_eff · ‖v_step + (ω_core × r_joint) + v_limb‖ */
export function computeImpact(p: ImpactInput): ImpactResult {
  const omega = v3(0, p.omegaCore, 0);
  const vRot = cross(omega, p.rJoint);
  const vSum = add(add(p.vStep, vRot), p.vLimb);
  return { impulse: p.eta * p.mEff * length(vSum), vRot, vSum };
}

// ───────── 코어 회전 동역학 ─────────
export interface CoreState {
  yaw: number; // 골반/흉추 비틀림 (heading 기준)
  yawVel: number;
  spinOffset: number; // 몸 전체 스핀 누적 (rad)
  spinDir: -1 | 0 | 1;
  spinning: boolean; // 키 유지 중 스핀
  completing: boolean; // 키를 뗀 뒤 한 바퀴 마무리
  omegaHistory: { t: number; w: number }[];
}

export function createCoreState(): CoreState {
  return { yaw: CORE_NEUTRAL, yawVel: 0, spinOffset: 0, spinDir: 0, spinning: false, completing: false, omegaHistory: [] };
}

export interface CoreDrive {
  q: boolean; // KeyQ 유지
  e: boolean; // KeyE 유지
  qHeld: number; // 유지 시간
  eHeld: number;
  canSpin: boolean;
}

/** 스프링-댐퍼로 코어 비틀림을 갱신하고, 한계에서 계속 유지하면 몸 전체 스핀으로 전환 */
export function stepCore(c: CoreState, d: CoreDrive, dt: number, now: number): void {
  let target = CORE_NEUTRAL;
  if (d.q && !d.e) target = CORE_CCW;
  else if (d.e && !d.q) target = CORE_CW;
  [c.yaw, c.yawVel] = springStep(c.yaw, c.yawVel, target, CORE_OMEGA_N, CORE_ZETA, dt);

  let spinRate = 0;
  if (c.spinning) {
    const holding = c.spinDir === 1 ? d.q : d.e;
    if (holding) {
      spinRate = SPIN_RATE * c.spinDir;
    } else {
      c.spinning = false;
      c.completing = true;
    }
  } else if (!c.completing && d.canSpin) {
    if (d.q && !d.e && d.qHeld >= SPIN_HOLD && Math.abs(c.yaw - CORE_CCW) < 0.15) {
      c.spinning = true;
      c.spinDir = 1;
    } else if (d.e && !d.q && d.eHeld >= SPIN_HOLD && Math.abs(c.yaw - CORE_CW) < 0.15) {
      c.spinning = true;
      c.spinDir = -1;
    }
  }
  if (c.completing) {
    // 스핀 방향으로 다음 한 바퀴(2π 배수)까지 마저 돈다
    const full = Math.PI * 2;
    const goal = c.spinDir === 1 ? Math.ceil(c.spinOffset / full - 1e-6) * full : Math.floor(c.spinOffset / full + 1e-6) * full;
    const step = SPIN_RATE * dt;
    const remain = goal - c.spinOffset;
    if (Math.abs(remain) <= step) {
      spinRate = remain / dt;
      c.completing = false;
      c.spinDir = 0;
    } else {
      spinRate = SPIN_RATE * Math.sign(remain);
    }
  }
  c.spinOffset += spinRate * dt;
  if (!c.spinning && !c.completing) c.spinOffset = 0;

  const w = c.yawVel + spinRate;
  c.omegaHistory.push({ t: now, w });
  while (c.omegaHistory.length > 0 && c.omegaHistory[0].t < now - OMEGA_PEAK_WINDOW) c.omegaHistory.shift();
}

/** 스핀을 즉시 "마무리" 단계로 전환하고, 한 바퀴를 끝낼 때까지 남은 시간(초)을 돌려준다 */
export function commitSpin(c: CoreState): number {
  if (!c.spinning && !c.completing) return 0;
  c.spinning = false;
  c.completing = true;
  const full = Math.PI * 2;
  const goal = c.spinDir === 1 ? Math.ceil(c.spinOffset / full - 1e-6) * full : Math.floor(c.spinOffset / full + 1e-6) * full;
  return Math.abs(goal - c.spinOffset) / SPIN_RATE;
}

/** 현재 코어 각속도 (비틀림 + 스핀) */
export function currentOmega(c: CoreState): number {
  const last = c.omegaHistory[c.omegaHistory.length - 1];
  return last ? last.w : 0;
}

/**
 * 최근 OMEGA_PEAK_WINDOW 동안의 부호 있는 피크 각속도.
 * 코어가 먼저 회전하고 사지가 뒤이어 뻗는 운동 사슬에서, 사지에 실리는 코어 회전 성분으로 사용한다.
 */
export function peakOmega(c: CoreState): number {
  let best = 0;
  for (const h of c.omegaHistory) if (Math.abs(h.w) > Math.abs(best)) best = h.w;
  return best;
}

/** 누적 회전 각도 (도). + = KeyQ 방향. 기본 스탠스 비틀림 기준 */
export function rotationDegrees(c: CoreState): number {
  return ((c.yaw - CORE_NEUTRAL + c.spinOffset) * 180) / Math.PI;
}
