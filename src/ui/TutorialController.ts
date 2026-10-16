// 인터랙티브 튜토리얼: 대표 기술 시범(가상 키 재생) + 따라 치기 연습 판정
import type { CombatWorld } from '../combat/CombatWorld';
import type { InputBuffer } from '../input/ErgonomicInputManager';
import type { ControlKey, TechniqueId, WorldEvent } from '../types/combat';

/** [키, 시작 시각(s), 유지 시간(s)] */
export type GuideStep = [code: ControlKey, at: number, hold: number];

export interface GuideEntry {
  id: TechniqueId;
  title: string;
  en: string;
  desc: string;
  sequence: string[]; // 표시용 키 순서
  script: GuideStep[]; // 시범 재생 (헤드리스 테스트로 검증된 타이밍)
}

export const GUIDE: GuideEntry[] = [
  {
    id: 'jab', title: '잽', en: 'Jab', desc: '앞손을 곧게 뻗는 기본기. W 와 함께면 스텝 인 잽.',
    sequence: ['U'], script: [['KeyU', 0, 0.08]],
  },
  {
    id: 'rightCross', title: '라이트 크로스', en: 'Right Cross', desc: '지면 반발 → 코어 좌회전 → 뒷손. 30~180ms 간격이면 Perfect Chain ×1.5.',
    sequence: ['Space', 'Q', 'I'], script: [['Space', 0, 0.06], ['KeyQ', 0.09, 0.15], ['KeyI', 0.18, 0.08]],
  },
  {
    id: 'leftLiverHook', title: '레프트 리버 블로우', en: 'Liver Hook', desc: '자세를 낮추고(Shift) 우회전 + 수평 궤적으로 상대 오른쪽 옆구리를 친다.',
    sequence: ['Shift(유지)', 'W', 'E', 'L', 'U'],
    script: [['ShiftLeft', 0, 0.8], ['KeyW', 0.2, 0.08], ['KeyE', 0.29, 0.2], ['KeyL', 0.32, 0.3], ['KeyU', 0.39, 0.08]],
  },
  {
    id: 'brazilianKick', title: '브라질리언 킥', en: 'Question Mark Kick', desc: '앞차기처럼 K 를 찬 뒤 신전 15~45% 구간에 Q+L → 공중에서 궤적이 꺾여 머리를 덮친다.',
    sequence: ['K', '→ 곧바로 Q+L'], script: [['KeyK', 0, 0.1], ['KeyQ', 0.08, 0.2], ['KeyL', 0.08, 0.2]],
  },
  {
    id: 'clinchKnee', title: '클린치 니킥', en: 'Clinch Knee', desc: '다가가 M 으로 목을 잡고(유지), ; + O 로 무릎을 접어 올려 K.',
    sequence: ['W', 'M(유지)', '; + O', 'K'],
    script: [['KeyW', 0, 0.3], ['KeyM', 0.35, 1.2], ['Semicolon', 0.8, 0.4], ['KeyO', 0.8, 0.4], ['KeyK', 0.9, 0.1]],
  },
  {
    id: 'spinningBackKick', title: '뒤차기', en: 'Spinning Back Kick', desc: 'Q 를 길게 눌러 몸을 135° 이상 돌리고, Space 로 박차며 K.',
    sequence: ['Q(길게)', 'Space', 'K'], script: [['KeyQ', 0, 0.5], ['Space', 0.15, 0.06], ['KeyK', 0.4, 0.1]],
  },
  {
    id: 'doubleLegTakedown', title: '더블 렉 테이크다운', en: 'Double Leg', desc: 'Shift 로 낮추고 W + Space 로 돌진하며 U + I + M 으로 두 다리를 잡는다.',
    sequence: ['Shift', 'W', 'Space', 'U+I+M'],
    script: [['ShiftLeft', 0, 0.9], ['KeyW', 0.05, 0.6], ['Space', 0.12, 0.06], ['KeyU', 0.2, 0.4], ['KeyI', 0.2, 0.4], ['KeyM', 0.2, 0.4]],
  },
];

const DEMO_LEAD = 0.35;
const DEMO_TAIL = 1.3;

export type TutorialMode = 'idle' | 'demo' | 'practice';

export class TutorialController {
  mode: TutorialMode = 'idle';
  entry: GuideEntry | null = null;
  successes = 0;
  attempts = 0;
  lastAttempt: string | null = null;
  lastSuccessAt = -Infinity;
  private sched: { at: number; code: ControlKey; down: boolean }[] = [];
  private demoEnd = 0;

  constructor(
    private readonly world: CombatWorld,
    private readonly input: InputBuffer & { suppressed: boolean },
  ) {}

  startDemo(entry: GuideEntry, now: number): void {
    this.endDemo(now);
    this.entry = entry;
    this.mode = 'demo';
    this.input.suppressed = true;
    this.input.releaseAll(now);
    this.world.resetPositions();
    this.world.ai.suspend(true, now);
    this.sched = [];
    let end = now;
    for (const [code, at, hold] of entry.script) {
      const t = now + DEMO_LEAD + at;
      this.sched.push({ at: t, code, down: true }, { at: t + hold, code, down: false });
      end = Math.max(end, t + hold);
    }
    this.sched.sort((a, b) => a.at - b.at);
    this.demoEnd = end + DEMO_TAIL;
  }

  startPractice(entry: GuideEntry, now: number): void {
    this.endDemo(now);
    this.entry = entry;
    this.mode = 'practice';
    this.successes = 0;
    this.attempts = 0;
    this.lastAttempt = null;
    this.world.resetPositions();
  }

  stop(now: number): void {
    this.endDemo(now);
    this.mode = 'idle';
    this.entry = null;
  }

  private endDemo(now: number): void {
    if (this.mode !== 'demo') return;
    this.sched = [];
    this.input.releaseAll(now);
    this.input.suppressed = false;
    this.world.ai.suspend(false, now);
  }

  /** 고정 스텝마다 호출: 예약된 시범 키를 원래 타임스탬프로 발행 */
  update(now: number): void {
    if (this.mode !== 'demo') return;
    while (this.sched.length && this.sched[0].at <= now) {
      const k = this.sched.shift()!;
      if (k.down) this.input.press(k.code, k.at);
      else this.input.release(k.code, k.at);
    }
    if (now >= this.demoEnd && this.entry) {
      // 시범이 끝나면 같은 기술의 따라 치기 연습으로 전환
      const e = this.entry;
      this.endDemo(now);
      this.startPractice(e, now);
    }
  }

  onEvents(events: WorldEvent[], now: number): void {
    if (this.mode !== 'practice' || !this.entry) return;
    for (const e of events) {
      if (e.type !== 'technique' || e.fighter !== 'player') continue;
      if (e.technique.id === this.entry.id) {
        this.successes++;
        this.lastSuccessAt = now;
        this.lastAttempt = null;
      } else if (e.technique.id !== 'guard' && e.technique.id !== 'grab') {
        if (!e.updated) this.attempts++;
        this.lastAttempt = `${e.technique.nameKo} (${e.technique.name})`;
      }
    }
  }
}
