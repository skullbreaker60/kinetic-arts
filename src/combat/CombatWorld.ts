// 렌더링과 무관한 시뮬레이션 월드 (헤드리스 테스트 가능)
import { AIMode, SparringPartnerAI } from '../ai/SparringPartnerAI';
import { clamp, v3 } from '../core/math';
import type { InputBuffer } from '../input/ErgonomicInputManager';
import type { WorldEvent } from '../types/combat';
import { CombatSystem } from './CombatSystem';
import { FighterController } from './FighterController';

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
export const START_DISTANCE = 0.85;

export class CombatWorld {
  readonly player: FighterController;
  readonly opponent: FighterController;
  readonly ai: SparringPartnerAI;
  readonly combat = new CombatSystem();
  hitstop = 0;
  simTime = 0;
  private events: WorldEvent[] = [];

  constructor(seed = 7, playerInput?: InputBuffer) {
    this.player = new FighterController({ name: 'player', hasHp: false, pos: v3(0, 0, -START_DISTANCE / 2), color: 0x39d0ff, input: playerInput });
    this.opponent = new FighterController({ name: 'opponent', hasHp: true, pos: v3(0, 0, START_DISTANCE / 2), color: 0xff8a3d });
    this.player.resetTo(v3(0, 0, -START_DISTANCE / 2), 0);
    this.opponent.resetTo(v3(0, 0, START_DISTANCE / 2), Math.PI);
    this.ai = new SparringPartnerAI(this.opponent, seed);
  }

  setMode(mode: AIMode, now: number): void {
    this.resetPositions();
    this.ai.setMode(mode, now);
  }

  resetPositions(): void {
    this.player.resetTo(v3(0, 0, -START_DISTANCE / 2), 0);
    this.opponent.resetTo(v3(0, 0, START_DISTANCE / 2), Math.PI);
  }

  /** 고정 스텝 1회. now = 입력 타임스탬프와 같은 기준의 현재 시각(초) */
  step(dt: number, now: number): void {
    if (this.hitstop > 0) {
      // 히트 스톱: 물리 정지 (입력은 버퍼에 쌓였다가 재개 시 원래 타임스탬프로 처리)
      this.hitstop = Math.max(0, this.hitstop - dt);
      return;
    }
    this.simTime += dt;
    this.ai.update(now, this.player);
    this.player.update(dt, now, this.opponent);
    this.opponent.update(dt, now, this.player);
    this.combat.separate(this.player, this.opponent);

    const hits = [...this.combat.resolve(this.player, this.opponent), ...this.combat.resolve(this.opponent, this.player)];
    for (const h of hits) {
      if (h.type === 'hit') this.hitstop = Math.max(this.hitstop, clamp(0.03 + h.impulse * 0.004, 0.03, 0.14));
    }
    this.events.push(...this.player.drainEvents(), ...this.opponent.drainEvents(), ...hits);
  }

  drainEvents(): WorldEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
