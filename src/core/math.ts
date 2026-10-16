// 엔진 독립 수학 유틸리티 (Three.js 비의존 → Unity/Unreal 이식 용이)
// 월드 좌표: +y 위, 요(yaw) θ 일 때 전방 = (sin θ, 0, cos θ), 오른쪽 = (-cos θ, 0, sin θ)

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const ZERO: Vec3 = v3(0, 0, 0);
export const UP: Vec3 = v3(0, 1, 0);

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 =>
  v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lengthXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const distanceXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const flatXZ = (a: Vec3): Vec3 => v3(a.x, 0, a.z);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export function normalize(a: Vec3, fallback: Vec3 = v3(0, 0, 1)): Vec3 {
  const l = length(a);
  return l < 1e-9 ? fallback : scale(a, 1 / l);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/** 직교 기저 (forward / up / right). pitch>0 이면 앞으로 숙임 */
export interface Basis {
  forward: Vec3;
  up: Vec3;
  right: Vec3;
}

export function yawBasis(yaw: number): Basis {
  return {
    forward: v3(Math.sin(yaw), 0, Math.cos(yaw)),
    up: UP,
    right: v3(-Math.cos(yaw), 0, Math.sin(yaw)),
  };
}

export function bodyBasis(yaw: number, pitch: number): Basis {
  const b = yawBasis(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    forward: add(scale(b.forward, cp), scale(UP, -sp)),
    up: add(scale(UP, cp), scale(b.forward, sp)),
    right: b.right,
  };
}

/** 기저 로컬 좌표 (x=오른쪽, y=위, z=전방) → 월드 */
export function toWorld(origin: Vec3, basis: Basis, local: Vec3): Vec3 {
  return v3(
    origin.x + basis.right.x * local.x + basis.up.x * local.y + basis.forward.x * local.z,
    origin.y + basis.right.y * local.x + basis.up.y * local.y + basis.forward.y * local.z,
    origin.z + basis.right.z * local.x + basis.up.z * local.y + basis.forward.z * local.z,
  );
}

/** 월드 → 기저 로컬 (직교 기저 가정) */
export function toLocal(origin: Vec3, basis: Basis, world: Vec3): Vec3 {
  const d = sub(world, origin);
  return v3(dot(d, basis.right), dot(d, basis.up), dot(d, basis.forward));
}

/** 로컬 방향 벡터 → 월드 방향 */
export function dirToWorld(basis: Basis, local: Vec3): Vec3 {
  return toWorld(ZERO, basis, local);
}

export const yawTowards = (from: Vec3, to: Vec3): number => Math.atan2(to.x - from.x, to.z - from.z);

/** 반암시적 오일러 스프링-댐퍼 1스텝. 반환: [위치, 속도] */
export function springStep(
  x: number,
  v: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): [number, number] {
  const a = omega * omega * (target - x) - 2 * zeta * omega * v;
  const nv = v + a * dt;
  return [x + nv * dt, nv];
}

export function expDecay(value: number, rate: number, dt: number): number {
  return value * Math.exp(-rate * dt);
}

/** 점 p 와 선분 ab 사이의 최근접점 */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < 1e-12) return a;
  const t = clamp(dot(sub(p, a), ab) / denom, 0, 1);
  return addScaled(a, ab, t);
}
