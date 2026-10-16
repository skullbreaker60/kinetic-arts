import { CombatWorld, FIXED_DT } from '../src/combat/CombatWorld';
import type { FighterController } from '../src/combat/FighterController';
import type { ControlKey, WorldEvent } from '../src/types/combat';

export type Step = [code: ControlKey, at: number, hold: number];

export interface RunResult {
  events: WorldEvent[];
  maxRatio: number;
  end: number;
}

/** fighter 에게 키 스크립트를 주입하며 world 를 seconds 동안 진행 */
export function runScript(world: CombatWorld, fighter: FighterController, steps: Step[], seconds: number, t0: number): RunResult {
  const sched: { at: number; code: ControlKey; down: boolean }[] = [];
  for (const [code, at, hold] of steps) {
    sched.push({ at: t0 + at, code, down: true }, { at: t0 + at + hold, code, down: false });
  }
  sched.sort((a, b) => a.at - b.at);
  const events: WorldEvent[] = [];
  let now = t0;
  let maxRatio = 0;
  const end = t0 + seconds;
  while (now < end) {
    while (sched.length && sched[0].at <= now) {
      const k = sched.shift()!;
      if (k.down) fighter.input.press(k.code, k.at);
      else fighter.input.release(k.code, k.at);
    }
    world.step(FIXED_DT, now);
    events.push(...world.drainEvents());
    if (Number.isFinite(fighter.balance.ratio)) maxRatio = Math.max(maxRatio, fighter.balance.ratio);
    now += FIXED_DT;
  }
  return { events, maxRatio, end };
}

export function techniques(r: RunResult, fighter = 'player'): string[] {
  return r.events.filter((e) => e.type === 'technique' && e.fighter === fighter).map((e) => (e.type === 'technique' ? e.technique.id : ''));
}

export function hits(r: RunResult, attacker = 'player') {
  return r.events.flatMap((e) => (e.type === 'hit' && e.attacker === attacker ? [e] : []));
}
