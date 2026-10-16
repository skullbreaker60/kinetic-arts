// 2-Bone 해석적 IK 솔버 (코사인 법칙) — 엔진 독립
import { Vec3, add, addScaled, clamp, cross, dot, length, normalize, scale, sub, v3 } from './math';

export interface TwoBoneResult {
  mid: Vec3; // 팔꿈치 / 무릎
  end: Vec3; // 손목 / 발목 (도달 불가 시 최대 신전 위치로 클램프)
  reachRatio: number; // |end-root| / (l1+l2)
}

/**
 * root(어깨/고관절) → target 으로 l1, l2 두 뼈를 뻗는다.
 * pole 은 중간 관절이 향할 방향을 지시하는 월드 좌표 점이 아닌 "방향 벡터"이다.
 */
export function solveTwoBoneIK(root: Vec3, target: Vec3, l1: number, l2: number, pole: Vec3): TwoBoneResult {
  const toTarget = sub(target, root);
  const rawDist = length(toTarget);
  const maxReach = l1 + l2 - 1e-4;
  const minReach = Math.abs(l1 - l2) + 1e-4;
  const d = clamp(rawDist, minReach, maxReach);
  const dir = normalize(toTarget, v3(0, -1, 0));

  // 폴 벡터를 dir 에 수직인 평면으로 투영
  let polar = sub(pole, scale(dir, dot(pole, dir)));
  if (length(polar) < 1e-6) {
    // 폴이 축과 평행 → 임의의 수직축 선택
    const alt = Math.abs(dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
    polar = cross(dir, alt);
  }
  polar = normalize(polar);

  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mid = add(addScaled(root, dir, a), scale(polar, h));
  const end = addScaled(root, dir, d);
  return { mid, end, reachRatio: d / (l1 + l2) };
}
