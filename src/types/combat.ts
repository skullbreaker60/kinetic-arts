// 입력 · 관절 · 운동 사슬 · 기술 판정 공용 인터페이스
import type { Vec3 } from '../core/math';

// ───────── 입력 ─────────
export const LEFT_HAND_KEYS = [
  'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ControlLeft', 'Space',
] as const;
export const RIGHT_HAND_KEYS = [
  'KeyU', 'KeyI', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'Semicolon', 'KeyM',
] as const;

export type LeftHandKey = (typeof LEFT_HAND_KEYS)[number];
export type RightHandKey = (typeof RIGHT_HAND_KEYS)[number];
export type ControlKey = LeftHandKey | RightHandKey;
export const ALL_KEYS: readonly ControlKey[] = [...LEFT_HAND_KEYS, ...RIGHT_HAND_KEYS];

/** 하체(지면) 입력: 보법 + 지면 반발 */
export const GROUND_KEYS: readonly ControlKey[] = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'];
/** 코어 회전 입력 */
export const CORE_KEYS: readonly ControlKey[] = ['KeyQ', 'KeyE'];
/** 사지 신전 입력 */
export const LIMB_KEYS = ['KeyU', 'KeyI', 'KeyJ', 'KeyK'] as const;
export type LimbKey = (typeof LIMB_KEYS)[number];

export function isControlKey(code: string): code is ControlKey {
  return (ALL_KEYS as readonly string[]).includes(code);
}

export interface KeyState {
  down: boolean;
  pressedAt: number; // 초 (-Infinity = 누른 적 없음)
  releasedAt: number;
}

export interface KeyEvent {
  code: ControlKey;
  down: boolean;
  time: number; // 초
}

// ───────── 운동 사슬 ─────────
export type ChainGrade = 'perfect' | 'simultaneous' | 'isolated';

export interface ChainEvaluation {
  grade: ChainGrade;
  eta: number; // η_chain
  dt1: number | null; // t_core - t_ground
  dt2: number | null; // t_limb - t_core
  tGround: number | null;
  tCore: number | null;
  tLimb: number;
}

// ───────── 신체 ─────────
export type LimbId = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
export type Side = 'left' | 'right';
export const LIMB_BY_KEY: Record<LimbKey, LimbId> = {
  KeyU: 'leftArm',
  KeyI: 'rightArm',
  KeyJ: 'leftLeg',
  KeyK: 'rightLeg',
};
export const limbSide = (limb: LimbId): Side => (limb.startsWith('left') ? 'left' : 'right');
export const isLegLimb = (limb: LimbId): boolean => limb.endsWith('Leg');

/** 명세서에 나열된 관절 (골반, 요추, 흉추, 머리, 양쪽 어깨/팔꿈치/손목, 양쪽 고관절/무릎/발목) */
export const JOINT_NAMES = [
  'pelvis', 'lumbar', 'thorax', 'head',
  'lShoulder', 'lElbow', 'lWrist', 'rShoulder', 'rElbow', 'rWrist',
  'lHip', 'lKnee', 'lAnkle', 'rHip', 'rKnee', 'rAnkle',
] as const;
export type JointName = (typeof JOINT_NAMES)[number];
export type Pose = Record<JointName, Vec3>;

// ───────── 궤적 / 타격 ─────────
export type TrajectoryShape = 'straight' | 'horizontal' | 'verticalUp' | 'verticalDown' | 'overTop';
export type StrikeLevel = 'high' | 'mid' | 'low';
export type StrikerPart = 'fist' | 'elbow' | 'foot' | 'knee';
export type HitZone = 'head' | 'body' | 'liver' | 'leg';

export interface TrajectoryFlags {
  horizontal: boolean; // KeyL
  vertical: boolean; // KeyO
  chamber: boolean; // Semicolon
  overTop: boolean; // 페인트로 생긴 물음표 궤적
}

/** 3차 베지어 제어점 [P0, P1, P2, P3] */
export type BezierCurve = readonly [Vec3, Vec3, Vec3, Vec3];

// ───────── 기술 판정 ─────────
export type TechniqueId =
  | 'jab' | 'rightCross' | 'leftHook' | 'leftLiverHook' | 'rightUppercut'
  | 'spinningBackfist' | 'horizontalElbow' | 'teep' | 'roundhouse' | 'brazilianKick'
  | 'clinchKnee' | 'spinningBackKick' | 'doubleLegTakedown' | 'guard' | 'parry'
  | 'grab' | 'freeform';

export interface TechniqueResult {
  id: TechniqueId;
  name: string; // 영문
  nameKo: string; // 한글
}

// ───────── 파이터 상태 ─────────
export type FighterStatus = 'normal' | 'hitstun' | 'stumble' | 'knockdown' | 'ko';
export type GrabPart = 'neck' | 'wrist' | 'leg';

export interface MassFactor {
  label: string;
  value: number;
}

/** HUD 운동 사슬 분석기용 텔레메트리 */
export interface ChainTelemetry {
  limb: LimbId | null;
  technique: TechniqueResult;
  chain: ChainEvaluation;
  mEff: number;
  massFactors: MassFactor[];
  vStep: number; // |v_step|
  vRot: number; // |ω_core × r_joint|
  omega: number; // ω_core (rad/s, 부호 = 회전 방향)
  vLimb: number; // |v_limb|
  impulse: number; // I_impact
  shape: TrajectoryShape;
  striker: StrikerPart;
  final: boolean; // 적중으로 확정된 값인가
  zone: HitZone | null;
  time: number;
}

export type BoSKind = 'capsule' | 'circle' | 'none';
export interface BaseOfSupport {
  kind: BoSKind;
  a: Vec3; // 캡슐 시작 / 원 중심
  b: Vec3; // 캡슐 끝 (원이면 a 와 동일)
  radius: number;
}

export interface BalanceState {
  com: Vec3; // 3D 무게중심
  comXZ: Vec3; // 동역학 보정된 투영점 C_xz (y=0)
  bos: BaseOfSupport;
  center: Vec3; // B_center
  ratio: number; // StabilityRatio
}

// ───────── 월드 이벤트 (HUD/렌더러 소비) ─────────
export type EnergyStage = 'ground' | 'core' | 'limb';

export type WorldEvent =
  | { type: 'technique'; fighter: string; technique: TechniqueResult; telemetry: ChainTelemetry; updated: boolean }
  | { type: 'hit'; attacker: string; defender: string; point: Vec3; impulse: number; damage: number; zone: HitZone; blocked: boolean; counter: boolean; technique: TechniqueResult }
  | { type: 'parry'; fighter: string; point: Vec3 }
  | { type: 'grab'; fighter: string; part: GrabPart | 'miss' }
  | { type: 'takedown'; fighter: string; success: boolean; impulse: number }
  | { type: 'stumble'; fighter: string }
  | { type: 'knockdown'; fighter: string; reason: 'counter' | 'takedown' }
  | { type: 'ko'; fighter: string }
  | { type: 'recover'; fighter: string }
  | { type: 'telegraph'; fighter: string }
  | { type: 'energy'; fighter: string; stage: EnergyStage; limb: LimbId | null; time: number };
