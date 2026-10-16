// 무게중심(CoM) · 지지면(BoS) · StabilityRatio · 비틀거림(Stumble) 판정 (명세 3.4)
import { Vec3, add, addScaled, closestPointOnSegment, distanceXZ, flatXZ, lerp, scale, v3 } from '../core/math';
import type { BalanceState, BaseOfSupport, Pose } from '../types/combat';

export const CAPSULE_RADIUS = 0.15; // 양발 지지 캡슐 반경
export const SINGLE_FOOT_RADIUS = 0.12; // 한 발 지지 원 반경 (축소)
export const STUMBLE_DURATION = 0.6; // s
const VELOCITY_LEAD = 0.035; // 속도에 의한 투영점 선행 (s)
const OMEGA_LEAD = 0.004; // 회전 각속도에 의한 투영점 이동 (m per rad/s)

/** 분절 질량비 (Dempster 근사, 합 = 1) */
const SEGMENTS: { a: keyof Pose; b: keyof Pose; m: number }[] = [
  { a: 'head', b: 'head', m: 0.081 },
  { a: 'pelvis', b: 'thorax', m: 0.497 },
  { a: 'lShoulder', b: 'lElbow', m: 0.028 },
  { a: 'rShoulder', b: 'rElbow', m: 0.028 },
  { a: 'lElbow', b: 'lWrist', m: 0.022 },
  { a: 'rElbow', b: 'rWrist', m: 0.022 },
  { a: 'lHip', b: 'lKnee', m: 0.1 },
  { a: 'rHip', b: 'rKnee', m: 0.1 },
  { a: 'lKnee', b: 'lAnkle', m: 0.061 },
  { a: 'rKnee', b: 'rAnkle', m: 0.061 },
];

export function computeCoM(pose: Pose): Vec3 {
  let c = v3();
  for (const s of SEGMENTS) c = addScaled(c, lerp(pose[s.a], pose[s.b], 0.5), s.m);
  return c;
}

/** 지지 발 목록으로 지지면 생성: 2발 = 캡슐, 1발 = 축소된 원, 0발 = 없음 */
export function computeBoS(supportFeet: Vec3[]): BaseOfSupport {
  if (supportFeet.length >= 2) {
    return { kind: 'capsule', a: flatXZ(supportFeet[0]), b: flatXZ(supportFeet[1]), radius: CAPSULE_RADIUS };
  }
  if (supportFeet.length === 1) {
    const p = flatXZ(supportFeet[0]);
    return { kind: 'circle', a: p, b: p, radius: SINGLE_FOOT_RADIUS };
  }
  return { kind: 'none', a: v3(), b: v3(), radius: 0 };
}

/**
 * StabilityRatio = ‖C_xz − B_center‖ / R_BoS
 * 캡슐은 "축 선분 위 최근접점"을 B_center 로 쓴다 (원은 중심 그대로) → ratio ≤ 1 ⇔ 지지면 내부
 */
export function stabilityRatio(cxz: Vec3, bos: BaseOfSupport): { ratio: number; center: Vec3 } {
  if (bos.kind === 'none') return { ratio: Infinity, center: cxz };
  const center = bos.kind === 'capsule' ? closestPointOnSegment(cxz, bos.a, bos.b) : bos.a;
  return { ratio: distanceXZ(cxz, center) / bos.radius, center };
}

export interface BalanceInput {
  pose: Pose;
  supportFeet: Vec3[];
  rootVel: Vec3;
  coreOmega: number;
  torsoForward: Vec3;
}

export function evaluateBalance(inp: BalanceInput): BalanceState {
  const com = computeCoM(inp.pose);
  // 동적 투영점: 이동 속도 선행 + 회전 원심 성분
  let cxz = flatXZ(com);
  cxz = addScaled(cxz, flatXZ(inp.rootVel), VELOCITY_LEAD);
  cxz = add(cxz, scale(flatXZ(inp.torsoForward), Math.abs(inp.coreOmega) * OMEGA_LEAD));
  const bos = computeBoS(inp.supportFeet);
  const { ratio, center } = stabilityRatio(cxz, bos);
  return { com, comXZ: cxz, bos, center, ratio };
}

/**
 * 불안정 누적기. ratio > 1 상태에서 무리한 회전/타격을 이어가면 수치가 급증하고,
 * 1.0 에 도달하면 Stumble(0.6s 입력 페널티)을 발생시킨다.
 */
export class BalanceMonitor {
  instability = 0;

  /** 매 스텝: stressed = 강한 회전 중이거나 타격 동작 중 */
  update(ratio: number, stressed: boolean, dt: number): boolean {
    if (ratio > 1 && stressed) {
      this.instability += (Math.min(ratio, 3) - 1 + 0.35) * 2.6 * dt;
    } else {
      this.instability = Math.max(0, this.instability - 1.4 * dt);
    }
    return this.check();
  }

  /** 불안정 상태(ratio > 1)에서 새 회전/타격을 시작하면 즉시 급증 */
  actionSpike(ratio: number): boolean {
    if (ratio > 1) this.instability += 0.5;
    return this.check();
  }

  reset(): void {
    this.instability = 0;
  }

  private check(): boolean {
    if (this.instability >= 1) {
      this.instability = 0;
      return true;
    }
    return false;
  }
}
