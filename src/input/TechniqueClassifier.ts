// 활성 키 + 물리 상태 → 발현 무술 기술명 실시간 추론 (명세 4장 판정표)
import type { ControlKey, LimbId, TechniqueId, TechniqueResult, TrajectoryFlags } from '../types/combat';

export const TECHNIQUES: Record<TechniqueId, TechniqueResult> = {
  jab: { id: 'jab', name: 'Jab', nameKo: '잽' },
  rightCross: { id: 'rightCross', name: 'Right Cross', nameKo: '라이트 크로스' },
  leftHook: { id: 'leftHook', name: 'Left Hook', nameKo: '레프트 훅' },
  leftLiverHook: { id: 'leftLiverHook', name: 'Left Liver Hook', nameKo: '레프트 리버 블로우' },
  rightUppercut: { id: 'rightUppercut', name: 'Right Uppercut', nameKo: '라이트 어퍼컷' },
  spinningBackfist: { id: 'spinningBackfist', name: 'Spinning Backfist', nameKo: '스피닝 백피스트' },
  horizontalElbow: { id: 'horizontalElbow', name: 'Horizontal Elbow', nameKo: '수평 엘보우 슬래시' },
  teep: { id: 'teep', name: 'Teep (Push Kick)', nameKo: '앞차기 / 팁' },
  roundhouse: { id: 'roundhouse', name: 'Roundhouse Kick', nameKo: '오른발 돌려차기' },
  brazilianKick: { id: 'brazilianKick', name: 'Brazilian Kick', nameKo: '브라질리언 킥' },
  clinchKnee: { id: 'clinchKnee', name: 'Clinch Knee', nameKo: '클린치 니킥' },
  spinningBackKick: { id: 'spinningBackKick', name: 'Spinning Back Kick', nameKo: '뒤차기' },
  doubleLegTakedown: { id: 'doubleLegTakedown', name: 'Double Leg Takedown', nameKo: '더블 렉 테이크다운' },
  guard: { id: 'guard', name: 'Active Shell Guard', nameKo: '액티브 가드' },
  parry: { id: 'parry', name: 'Parry', nameKo: '패링' },
  grab: { id: 'grab', name: 'Grab / Clinch', nameKo: '파지 / 클린치' },
  freeform: { id: 'freeform', name: 'Freeform', nameKo: '자유 조합' },
};

export const SPIN_BACKFIST_DEG = 120;
export const SPIN_BACK_KICK_DEG = 135;
/** 브라질리언 킥 페인트 입력 구간 u ∈ [0.15, 0.45] */
export const BRAZILIAN_U_MIN = 0.15;
export const BRAZILIAN_U_MAX = 0.45;

export type ClassifierAction = 'strike' | 'guard' | 'parry' | 'grab' | 'takedown';

export interface ClassifierInput {
  action: ClassifierAction;
  limb: LimbId | null;
  /** 조합 활성 키 (발사 시 활성 + 페인트 구간에 추가된 키) */
  keys: ReadonlySet<ControlKey>;
  /** 누적 회전 각도(도). + = KeyQ(좌회전) 방향, - = KeyE(우회전) 방향 */
  rotationDeg: number;
  flags: TrajectoryFlags;
  clinched: boolean;
  /** 사지 신전 중 u ∈ [0.15, 0.45] 구간에 눌린 키 */
  feintWindowKeys: ReadonlySet<ControlKey>;
}

/** 더블 렉 테이크다운 조합: ShiftLeft + Space + KeyW + KeyU + KeyI + KeyM */
export function matchesDoubleLeg(keys: ReadonlySet<ControlKey>): boolean {
  return (['ShiftLeft', 'Space', 'KeyW', 'KeyU', 'KeyI', 'KeyM'] as const).every((k) => keys.has(k));
}

const JAB_FORBIDDEN: readonly ControlKey[] = [
  'KeyQ', 'KeyE', 'ShiftLeft', 'ControlLeft', 'Space', 'KeyO', 'KeyL', 'Semicolon', 'KeyM',
  'KeyS', 'KeyA', 'KeyD', 'KeyI', 'KeyJ', 'KeyK',
];

export function classifyTechnique(c: ClassifierInput): TechniqueResult {
  const k = (code: ControlKey) => c.keys.has(code);
  const { horizontal, vertical, chamber } = c.flags;
  const straight = !horizontal && !vertical && !chamber;

  if (c.action === 'takedown') return TECHNIQUES.doubleLegTakedown;
  if (c.action === 'guard') return TECHNIQUES.guard;
  if (c.action === 'parry') return TECHNIQUES.parry;
  if (c.action === 'grab') return TECHNIQUES.grab;
  if (!c.limb) return TECHNIQUES.freeform;

  const limb = c.limb;
  const arm = limb === 'leftArm' || limb === 'rightArm';
  const leg = !arm;

  // 11. 클린치 니킥: 파지 성공 + ; + O + J/K
  if (leg && c.clinched && chamber && vertical) return TECHNIQUES.clinchKnee;
  // 10. 브라질리언 킥: K 입력 후 u∈[0.15,0.45] 구간에 Q + L 추가 입력
  if (limb === 'rightLeg' && c.feintWindowKeys.has('KeyQ') && c.feintWindowKeys.has('KeyL')) {
    return TECHNIQUES.brazilianKick;
  }
  // 12. 뒤차기: Q (회전 > 135°) + Space + K
  if (limb === 'rightLeg' && c.rotationDeg > SPIN_BACK_KICK_DEG && k('Space')) return TECHNIQUES.spinningBackKick;
  // 9. 오른발 돌려차기: Space + Q + L + K
  if (limb === 'rightLeg' && k('Space') && k('KeyQ') && horizontal) return TECHNIQUES.roundhouse;
  // 8. 앞차기 / 팁: Ctrl + J/K
  if (leg && k('ControlLeft') && straight) return TECHNIQUES.teep;

  // 6. 스피닝 백피스트: E (회전 > 120°) + L + U
  if (limb === 'leftArm' && -c.rotationDeg > SPIN_BACKFIST_DEG && horizontal) return TECHNIQUES.spinningBackfist;
  // 7. 수평 엘보우: Q/E + ; + L + U/I
  if (arm && (k('KeyQ') || k('KeyE')) && chamber && horizontal) return TECHNIQUES.horizontalElbow;
  // 4. 레프트 리버 블로우: Shift + E + L + U
  if (limb === 'leftArm' && k('ShiftLeft') && k('KeyE') && horizontal && !chamber) return TECHNIQUES.leftLiverHook;
  // 3. 레프트 훅: E + L + U
  if (limb === 'leftArm' && k('KeyE') && horizontal && !chamber) return TECHNIQUES.leftHook;
  // 5. 라이트 어퍼컷: Shift + Q + O + I
  if (limb === 'rightArm' && k('ShiftLeft') && k('KeyQ') && vertical && !chamber) return TECHNIQUES.rightUppercut;
  // 2. 라이트 크로스: (Space) + Q + I
  if (limb === 'rightArm' && k('KeyQ') && straight) return TECHNIQUES.rightCross;
  // 1. 잽: U 단독 또는 W + U
  if (limb === 'leftArm' && straight && JAB_FORBIDDEN.every((f) => !k(f))) return TECHNIQUES.jab;

  return freeformName(limb, c.flags, k('ShiftLeft'));
}

/** 판정표에 없는 조합은 사지 + 궤적으로 서술적 이름만 붙인다 (새 기술 규칙을 만들지 않음) */
function freeformName(limb: LimbId, f: TrajectoryFlags, low: boolean): TechniqueResult {
  const sideEn = limb.startsWith('left') ? 'Left' : 'Right';
  const sideKo = limb.startsWith('left') ? '왼' : '오른';
  const arm = limb.endsWith('Arm');
  let partEn: string;
  let partKo: string;
  if (f.chamber) {
    partEn = arm ? 'Elbow' : 'Knee';
    partKo = arm ? '팔꿈치' : '무릎';
  } else {
    partEn = arm ? 'Punch' : 'Kick';
    partKo = arm ? '손 타격' : '발 차기';
  }
  const arcEn = f.overTop ? 'Over-top ' : f.horizontal && f.vertical ? 'Diagonal ' : f.horizontal ? 'Arc ' : f.vertical ? 'Vertical ' : 'Straight ';
  const arcKo = f.overTop ? '오버탑 ' : f.horizontal && f.vertical ? '대각 ' : f.horizontal ? '수평 ' : f.vertical ? '수직 ' : '직선 ';
  const lvlEn = low ? ' (Low)' : '';
  const lvlKo = low ? ' (하단)' : '';
  return {
    id: 'freeform',
    name: `${sideEn} ${arcEn}${partEn}${lvlEn}`,
    nameKo: `${sideKo}쪽 ${arcKo}${partKo}${lvlKo}`,
  };
}
