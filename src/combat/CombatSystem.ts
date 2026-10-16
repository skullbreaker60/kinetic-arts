// 사지 끝단 ↔ 부위별 히트박스 충돌 판정, I_impact 기반 데미지/넉백 적용
import {
  Vec3, add, closestPointOnSegment, distance, distanceXZ, dot, flatXZ, normalize, scale, sub, v3,
} from '../core/math';
import type { HitZone, StrikerPart, WorldEvent } from '../types/combat';
import { FighterController, HIT_ACTIVE_U, Strike } from './FighterController';

export const STRIKER_RADIUS: Record<StrikerPart, number> = { fist: 0.06, elbow: 0.07, foot: 0.08, knee: 0.08 };
const HEAD_RADIUS = 0.13;
const TORSO_RADIUS = 0.16;
const LEG_RADIUS = 0.08;
const MIN_SEPARATION = 0.5;
const CLINCH_SEPARATION = 0.42;
const ZONE_PRIORITY: Record<Hurtbox['zone'], number> = { head: 3, torso: 2, leg: 1 };

export interface Hurtbox {
  zone: 'head' | 'torso' | 'leg';
  a: Vec3;
  b: Vec3;
  radius: number;
}

export function buildHurtboxes(f: FighterController): Hurtbox[] {
  const p = f.pose;
  return [
    { zone: 'head', a: p.head, b: p.head, radius: HEAD_RADIUS },
    { zone: 'torso', a: p.thorax, b: add(p.pelvis, v3(0, 0.05, 0)), radius: TORSO_RADIUS },
    { zone: 'leg', a: p.lHip, b: p.lKnee, radius: LEG_RADIUS },
    { zone: 'leg', a: p.lKnee, b: p.lAnkle, radius: LEG_RADIUS },
    { zone: 'leg', a: p.rHip, b: p.rKnee, radius: LEG_RADIUS },
    { zone: 'leg', a: p.rKnee, b: p.rAnkle, radius: LEG_RADIUS },
  ];
}

/** 구(p, r) 와 캡슐 충돌 → 침투 깊이 (음수 = 비충돌) */
export function sphereCapsule(p: Vec3, r: number, box: Hurtbox): number {
  const c = closestPointOnSegment(p, box.a, box.b);
  return r + box.radius - distance(p, c);
}

/** 몸통 적중 지점이 상대의 오른쪽 아래 옆구리면 간(Liver) */
export function torsoZone(defender: FighterController, point: Vec3): HitZone {
  const t = defender.torso;
  const lateral = dot(sub(point, t.lumbar), t.chest.right);
  const low = point.y < t.lumbar.y + 0.12;
  return lateral > 0.03 && low ? 'liver' : 'body';
}

export function activeHitter(s: Strike): boolean {
  if (s.hasHit) return false;
  return (s.phase === 'extend' && s.u >= HIT_ACTIVE_U) || s.phase === 'hold';
}

export class CombatSystem {
  /** attacker 의 활성 타격을 defender 히트박스와 판정 */
  resolve(attacker: FighterController, defender: FighterController): WorldEvent[] {
    const out: WorldEvent[] = [];
    if (defender.downed) return out;
    const boxes = buildHurtboxes(defender);
    for (const s of attacker.strikes.values()) {
      if (!activeHitter(s)) continue;
      const r = STRIKER_RADIUS[s.striker];
      // 중단을 노린 무릎은 상대 허벅지를 스치며 올라가므로 다리 히트박스를 무시
      const ignoreLegs = s.striker === 'knee' && s.level !== 'low';
      // 어퍼컷은 몸통 앞을 스치며 올라가 턱을 친다 → 상승 중에는 몸통 무시
      const ignoreTorso = s.striker === 'fist' && s.shape === 'verticalUp' && s.vLimbLocal.y > 0;
      let best: { box: Hurtbox; depth: number } | null = null;
      for (const box of boxes) {
        if (ignoreLegs && box.zone === 'leg') continue;
        if (ignoreTorso && box.zone === 'torso') continue;
        const depth = sphereCapsule(s.tip, r, box);
        if (depth <= 0) continue;
        // 동시에 겹치면 머리 > 몸통 > 다리 우선
        if (!best || ZONE_PRIORITY[box.zone] > ZONE_PRIORITY[best.box.zone] ||
          (ZONE_PRIORITY[box.zone] === ZONE_PRIORITY[best.box.zone] && depth > best.depth)) {
          best = { box, depth };
        }
      }
      if (!best) continue;
      const zone: HitZone = best.box.zone === 'head' ? 'head' : best.box.zone === 'leg' ? 'leg' : torsoZone(defender, s.tip);
      const imp = attacker.impactFor(s);
      s.impulse = imp.impulse;
      s.hasHit = true;
      // 타격 방향 = 합성 속도 벡터 (훅은 옆에서, 스트레이트는 정면에서 들어온다)
      const fallback = normalize(flatXZ(sub(defender.pos, attacker.pos)));
      const dir = normalize(flatXZ(imp.vSum), fallback);
      const res = defender.receiveHit(imp.impulse, zone, dir);
      attacker.telemetry = attacker.strikeTelemetry(s, true, zone);
      attacker.cancelStrike(s.limb);
      out.push({
        type: 'hit',
        attacker: attacker.name,
        defender: defender.name,
        point: s.tip,
        impulse: imp.impulse,
        damage: res.damage,
        zone,
        blocked: res.blocked,
        counter: res.counter,
        technique: s.technique,
      });
    }
    return out;
  }

  /** 두 파이터가 겹치지 않도록 분리 */
  separate(a: FighterController, b: FighterController): void {
    const clinched = a.clinch !== null || b.clinch !== null;
    const minD = clinched ? CLINCH_SEPARATION : MIN_SEPARATION;
    const d = distanceXZ(a.pos, b.pos);
    if (d >= minD || a.downed || b.downed) return;
    const n = d < 1e-6 ? v3(0, 0, 1) : normalize(flatXZ(sub(b.pos, a.pos)));
    const push = (minD - d) / 2;
    a.pos = sub(a.pos, scale(n, push));
    b.pos = add(b.pos, scale(n, push));
  }
}
