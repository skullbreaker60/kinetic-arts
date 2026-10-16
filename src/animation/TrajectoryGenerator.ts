// 3차 베지어 사지 궤적 생성 + 실시간 페인트(Feint) 보간 (명세 3.3)
// 모든 좌표는 "타격 프레임 로컬": x = 오른쪽, y = 위, z = 전방, 원점 = 캐릭터 발밑 루트
import { Vec3, add, addScaled, clamp, length, lerp, normalize, scale, sub, v3 } from '../core/math';
import type { BezierCurve, LimbId, StrikerPart, TrajectoryFlags, TrajectoryShape } from '../types/combat';

export const ARM_REACH = 0.6;
export const LEG_REACH = 0.92;
export const CHAMBER_RATIO = 0.45; // ; 유지 시 도달 거리 45%
export const PENETRATION = 0.08; // 타겟을 약간 관통하도록 조준
/** 페인트 허용 구간 0 < u ≤ 0.45 */
export const FEINT_U_MAX = 0.45;
export const FEINT_BLEND_TIME = 0.08; // s

export function bezierPoint(c: BezierCurve, u: number): Vec3 {
  const m = 1 - u;
  const b0 = m * m * m;
  const b1 = 3 * m * m * u;
  const b2 = 3 * m * u * u;
  const b3 = u * u * u;
  return v3(
    b0 * c[0].x + b1 * c[1].x + b2 * c[2].x + b3 * c[3].x,
    b0 * c[0].y + b1 * c[1].y + b2 * c[2].y + b3 * c[3].y,
    b0 * c[0].z + b1 * c[1].z + b2 * c[2].z + b3 * c[3].z,
  );
}

/** dP/du */
export function bezierTangent(c: BezierCurve, u: number): Vec3 {
  const m = 1 - u;
  const t0 = scale(sub(c[1], c[0]), 3 * m * m);
  const t1 = scale(sub(c[2], c[1]), 6 * m * u);
  const t2 = scale(sub(c[3], c[2]), 3 * u * u);
  return add(add(t0, t1), t2);
}

export function sampleBezier(c: BezierCurve, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(bezierPoint(c, i / n));
  return out;
}

/** 제어점 단위 Lerp (P0 는 두 곡선이 공유) */
export function blendCurves(a: BezierCurve, b: BezierCurve, t: number): BezierCurve {
  const k = clamp(t, 0, 1);
  return [a[0], lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k)];
}

export interface TrajectoryRequest {
  limb: LimbId;
  origin: Vec3; // P0: 어깨 또는 고관절 (로컬)
  aim: Vec3; // 타겟 부위 (로컬)
  flags: TrajectoryFlags;
}

export function trajectoryShape(flags: TrajectoryFlags, isLeg: boolean): TrajectoryShape {
  if (flags.overTop) return 'overTop';
  if (flags.horizontal) return 'horizontal';
  if (flags.vertical) return isLeg && !flags.chamber ? 'verticalDown' : 'verticalUp';
  return 'straight';
}

export function strikerPart(limb: LimbId, flags: TrajectoryFlags): StrikerPart {
  const arm = limb.endsWith('Arm');
  if (flags.chamber) return arm ? 'elbow' : 'knee';
  return arm ? 'fist' : 'foot';
}

export function strikeDuration(limb: LimbId, flags: TrajectoryFlags): number {
  const arm = limb.endsWith('Arm');
  if (arm) {
    if (flags.chamber) return 0.13;
    if (flags.horizontal) return 0.19;
    if (flags.vertical) return 0.18;
    return 0.15;
  }
  if (flags.chamber) return 0.2;
  if (flags.overTop) return 0.34;
  if (flags.horizontal) return 0.32;
  if (flags.vertical) return 0.34;
  return 0.27;
}

/**
 * P0 → P3 직선 기준 제어점을 만든 뒤 궤적 변환자에 따라 P1, P2 (필요 시 P3) 를 오프셋한다.
 *  - 기본: P1, P2 는 직선 위 (1/3, 2/3 지점)
 *  - KeyL 수평: 사지 바깥쪽으로 수평 오프셋 (훅 / 돌려차기)
 *  - KeyO 수직: 팔 = 아래→위 (어퍼컷), 다리 = 위→아래 (내려찍기), 무릎(;) = 아래→위 (니킥)
 *  - ; 접기: 도달 거리 45% → 팔꿈치/무릎이 타격점
 */
export function buildTrajectory(req: TrajectoryRequest): BezierCurve {
  const isLeg = req.limb.endsWith('Leg');
  const outwardSign = req.limb.startsWith('left') ? -1 : 1;
  const outward = v3(outwardSign, 0, 0);
  const inward = v3(-outwardSign, 0, 0);
  const upV = v3(0, 1, 0);
  const downV = v3(0, -1, 0);
  const f = req.flags;

  const P0 = req.origin;
  const toAim = sub(req.aim, P0);
  const dir = normalize(toAim, v3(0, 0, 1));
  const reach = isLeg ? LEG_REACH : ARM_REACH;
  let d = Math.min(length(toAim) + PENETRATION, reach);
  if (f.chamber) d *= CHAMBER_RATIO;
  let P3 = addScaled(P0, dir, d);

  if (f.chamber) {
    // 접힌 사지: 끝단(손/발)을 비켜 놓아 중간 관절(팔꿈치/무릎)이 타겟 방향으로 튀어나오게 한다
    P3 = isLeg ? add(P3, scale(downV, 0.4)) : add(P3, scale(inward, 0.2));
  }

  let P1 = lerp(P0, P3, 1 / 3);
  let P2 = lerp(P0, P3, 2 / 3);
  const span = Math.max(d, 0.3);

  if (f.overTop) {
    // 물음표 궤적: 앞차기처럼 솟아올랐다가 바깥 위에서 덮어 내려옴
    P1 = add(P1, add(scale(outward, 0.1 * span), scale(upV, 0.08 * span)));
    P2 = add(P3, add(scale(upV, 0.5 * span), scale(outward, 0.3 * span)));
  } else {
    if (f.horizontal) {
      const k = isLeg ? 0.6 : 0.55;
      P1 = add(P1, add(scale(outward, k * span), isLeg ? scale(downV, 0.1 * span) : v3()));
      P2 = add(P2, add(scale(outward, k * 0.85 * span), isLeg ? scale(upV, 0.12 * span) : v3()));
      P3 = add(P3, scale(inward, 0.04));
    }
    if (f.vertical) {
      if (isLeg && !f.chamber) {
        // 내려찍기: 위에서 아래로
        P1 = add(P1, add(scale(upV, 0.6 * span), scale(outward, 0.15 * span)));
        P2 = add(P2, scale(upV, 0.5 * span));
      } else {
        // 어퍼컷 / 니킥: 아래에서 위로
        const k = isLeg ? 0.15 : 0.32;
        P1 = add(P1, scale(downV, k * span));
        P2 = add(P2, scale(downV, k * 0.45 * span));
      }
    }
  }
  return [P0, P1, P2, P3];
}
