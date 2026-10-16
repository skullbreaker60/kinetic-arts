// 상대 캐릭터 AI — 사람과 똑같이 "가상 키 입력"으로 FighterController 를 조종한다.
// 따라서 AI 의 공격도 동일한 운동 사슬 / 궤적 / 밸런스 규칙을 따른다.
import { distanceXZ } from '../core/math';
import type { FighterController } from '../combat/FighterController';
import type { ControlKey } from '../types/combat';

export type AIMode = 'sandbag' | 'guardDummy' | 'sparring';

export const AI_MODE_LABELS: Record<AIMode, string> = {
  sandbag: '1. 고정 샌드백',
  guardDummy: '2. 가드 & 패링 연습 더미',
  sparring: '3. 능동형 스파링 AI',
};

interface ScheduledKey {
  at: number;
  code: ControlKey;
  down: boolean;
}

type ComboStep = [code: ControlKey, at: number, hold: number];

/** 사람의 플링킹 타이밍을 흉내 낸 콤보 스크립트 (초) */
const COMBOS: { name: string; steps: ComboStep[]; weight: number }[] = [
  { name: 'jab', steps: [['KeyU', 0, 0.08]], weight: 3 },
  { name: 'jab-cross', steps: [['KeyU', 0, 0.08], ['KeyW', 0.24, 0.08], ['KeyQ', 0.31, 0.12], ['KeyI', 0.4, 0.08]], weight: 3 },
  { name: 'cross', steps: [['Space', 0, 0.06], ['KeyQ', 0.08, 0.12], ['KeyI', 0.17, 0.08]], weight: 2 },
  { name: 'left-hook', steps: [['KeyW', 0, 0.08], ['KeyE', 0.08, 0.2], ['KeyL', 0.12, 0.2], ['KeyU', 0.17, 0.08]], weight: 2 },
  { name: 'liver', steps: [['ShiftLeft', 0, 0.45], ['KeyW', 0.05, 0.08], ['KeyE', 0.13, 0.2], ['KeyL', 0.16, 0.2], ['KeyU', 0.22, 0.08]], weight: 1 },
  { name: 'teep', steps: [['ControlLeft', 0, 0.45], ['KeyJ', 0.12, 0.1]], weight: 1 },
  { name: 'roundhouse', steps: [['Space', 0, 0.06], ['KeyQ', 0.07, 0.2], ['KeyL', 0.1, 0.25], ['KeyK', 0.15, 0.1]], weight: 2 },
];

/** 결정적 의사난수 (테스트 재현성) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SparringPartnerAI {
  mode: AIMode = 'sandbag';
  /** 튜토리얼 시범 중에는 공격/방어를 멈춘다 */
  suspended = false;
  private queue: ScheduledKey[] = [];
  private readonly rand: () => number;
  private nextAttack = 0;
  private scriptBusyUntil = 0;
  private nextMoveDecision = 0;
  private lateral: ControlKey | null = null;
  private readonly seenStrikes = new Set<number>();
  private readonly home;

  constructor(private readonly self: FighterController, seed = 7) {
    this.rand = mulberry32(seed);
    this.home = self.pos;
    this.self.anchor = this.home;
  }

  setMode(mode: AIMode, now: number): void {
    this.mode = mode;
    this.queue = [];
    this.self.input.releaseAll(now);
    this.self.anchor = mode === 'sandbag' ? this.home : null;
    this.nextAttack = now + 1.2;
    this.scriptBusyUntil = 0;
  }

  /** 튜토리얼 시범 동안 일시 정지: 예약된 키를 버리고 모든 키를 뗀다 */
  suspend(on: boolean, now: number): void {
    this.suspended = on;
    this.queue = [];
    this.self.input.releaseAll(now);
    this.scriptBusyUntil = 0;
    this.nextAttack = now + 1.0;
  }

  /** 대기 중인 가상 키를 now 까지 발행 (이벤트 시각은 예약 시각 그대로 → 플링킹 Δt 보존) */
  private flush(now: number): void {
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length > 0 && this.queue[0].at <= now) {
      const k = this.queue.shift()!;
      if (k.down) this.self.input.press(k.code, k.at);
      else this.self.input.release(k.code, k.at);
    }
  }

  private tap(code: ControlKey, at: number, hold: number): void {
    this.queue.push({ at, code, down: true }, { at: at + hold, code, down: false });
  }

  private runCombo(steps: ComboStep[], now: number): void {
    let end = now;
    for (const [code, at, hold] of steps) {
      this.tap(code, now + at, hold);
      end = Math.max(end, now + at + hold);
    }
    this.scriptBusyUntil = end + 0.05;
  }

  private setHeld(code: ControlKey, want: boolean, now: number): void {
    const down = this.self.input.isDown(code);
    if (want && !down) this.self.input.press(code, now);
    else if (!want && down) this.self.input.release(code, now);
  }

  private pickCombo(): ComboStep[] {
    const total = COMBOS.reduce((s, c) => s + c.weight, 0);
    let r = this.rand() * total;
    for (const c of COMBOS) {
      r -= c.weight;
      if (r <= 0) return c.steps;
    }
    return COMBOS[0].steps;
  }

  /** 상대(플레이어)의 새 타격 감지 → 반응 */
  private newOpponentStrikes(opp: FighterController): { arm: boolean; start: number; duration: number }[] {
    const found: { arm: boolean; start: number; duration: number }[] = [];
    for (const s of opp.strikes.values()) {
      if (this.seenStrikes.has(s.id)) continue;
      this.seenStrikes.add(s.id);
      found.push({ arm: !s.isLeg, start: s.startTime, duration: s.duration });
    }
    if (this.seenStrikes.size > 64) {
      const live = new Set([...opp.strikes.values()].map((s) => s.id));
      for (const id of this.seenStrikes) if (!live.has(id)) this.seenStrikes.delete(id);
    }
    return found;
  }

  /** 가드 상태에서 사지 단발 신전 → 패링 */
  private scheduleParry(start: number, duration: number, now: number): void {
    const at = Math.max(now, start + duration * 0.5);
    this.queue.push({ at: at - 0.05, code: 'Semicolon', down: true });
    this.tap('KeyU', at, 0.06);
    this.queue.push({ at: at + 0.25, code: 'Semicolon', down: false });
  }

  update(now: number, opp: FighterController): void {
    this.flush(now);
    const me = this.self;
    if (this.mode === 'sandbag') return;
    if (!me.actionable || this.suspended) {
      if (this.suspended) {
        for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD'] as ControlKey[]) this.setHeld(k, false, now);
      }
      this.newOpponentStrikes(opp);
      return;
    }
    const dist = distanceXZ(me.pos, opp.pos);
    const busy = now < this.scriptBusyUntil;

    if (this.mode === 'guardDummy') {
      this.updateGuardDummy(now, opp, dist, busy);
    } else {
      this.updateSparring(now, opp, dist, busy);
    }
  }

  private manageDistance(now: number, dist: number, desired: number, busy: boolean): void {
    if (busy) {
      this.setHeld('KeyS', false, now);
      if (!this.queue.some((q) => q.code === 'KeyW')) this.setHeld('KeyW', false, now);
      return;
    }
    this.setHeld('KeyW', dist > desired + 0.15, now);
    this.setHeld('KeyS', dist < desired - 0.25, now);
  }

  private updateGuardDummy(now: number, opp: FighterController, dist: number, busy: boolean): void {
    this.manageDistance(now, dist, 0.95, busy);
    if (!busy && !this.queue.some((q) => q.code === 'Semicolon')) this.setHeld('Semicolon', true, now);
    for (const s of this.newOpponentStrikes(opp)) {
      if (s.arm && this.rand() < 0.4) this.scheduleParry(s.start, s.duration, now);
    }
    if (now >= this.nextAttack && !busy) {
      // 예고(텔레그래프) 후 직선 공격 → 플레이어가 가드/패링을 연습
      this.self.events.push({ type: 'telegraph', fighter: this.self.name });
      this.queue.push({ at: now + 0.45, code: 'Semicolon', down: false });
      const steps: ComboStep[] = this.rand() < 0.5
        ? [['KeyU', 0.5, 0.08]]
        : [['KeyW', 0.42, 0.08], ['KeyQ', 0.5, 0.12], ['KeyI', 0.6, 0.08]];
      this.runCombo(steps, now);
      this.queue.push({ at: now + 1.05, code: 'Semicolon', down: true });
      this.scriptBusyUntil = now + 1.1;
      this.nextAttack = now + 2.4;
    }
  }

  private updateSparring(now: number, opp: FighterController, dist: number, busy: boolean): void {
    this.manageDistance(now, dist, 0.95, busy);
    if (!busy && now >= this.nextMoveDecision) {
      this.nextMoveDecision = now + 0.6 + this.rand() * 0.8;
      const r = this.rand();
      const want: ControlKey | null = r < 0.25 ? 'KeyA' : r < 0.5 ? 'KeyD' : null;
      if (this.lateral && this.lateral !== want) this.setHeld(this.lateral, false, now);
      this.lateral = want;
    }
    if (this.lateral) this.setHeld(this.lateral, !busy, now);

    for (const s of this.newOpponentStrikes(opp)) {
      const r = this.rand();
      const react = s.start + 0.17;
      if (r < 0.15 && s.arm) {
        this.scheduleParry(s.start, s.duration, now);
      } else if (r < 0.55) {
        this.queue.push({ at: Math.max(now, react), code: 'Semicolon', down: true });
        this.queue.push({ at: Math.max(now, react) + 0.45, code: 'Semicolon', down: false });
      } else if (r < 0.68) {
        this.tap(s.arm ? 'ShiftLeft' : 'KeyS', Math.max(now, react), 0.35);
      }
    }

    if (now >= this.nextAttack && !busy && dist < 1.2 && opp.status !== 'ko') {
      if (this.lateral) this.setHeld(this.lateral, false, now);
      this.runCombo(this.pickCombo(), now);
      this.nextAttack = this.scriptBusyUntil + 0.8 + this.rand() * 1.4;
    }
  }
}
