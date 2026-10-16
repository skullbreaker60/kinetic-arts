// 인체공학 입력 버퍼 + 피아노 연쇄(Plinking) 타이밍 판정
import {
  ALL_KEYS, CORE_KEYS, ChainEvaluation, ChainGrade, ControlKey, GROUND_KEYS, KeyEvent, KeyState,
  isControlKey,
} from '../types/combat';

export const CHAIN_SWEET_MIN = 0.03; // s
export const CHAIN_SWEET_MAX = 0.18; // s
/** 연쇄 탐색 시 이 시간보다 오래된 입력은 사슬 구성 요소로 보지 않는다 (판정 결과는 어차피 1.0) */
export const CHAIN_LOOKBACK = 0.6;
/** 조합 판정용 "활성 키" 윈도우: 눌려 있거나 이 시간 안에 눌렸던 키 */
export const COMBO_WINDOW = 0.3;
const HISTORY_SIZE = 12;
const EPS = 1e-9;

/** 명세 3.1 η_chain 판정 */
export function classifyChain(dt1: number | null, dt2: number | null): { grade: ChainGrade; eta: number } {
  if (dt1 === null || dt2 === null) return { grade: 'isolated', eta: 1.0 };
  const sweet = (dt: number) => dt >= CHAIN_SWEET_MIN - EPS && dt <= CHAIN_SWEET_MAX + EPS;
  const simul = (dt: number) => dt >= -EPS && dt < CHAIN_SWEET_MIN - EPS;
  if (sweet(dt1) && sweet(dt2)) return { grade: 'perfect', eta: 1.5 };
  if (simul(dt1) && simul(dt2)) return { grade: 'simultaneous', eta: 1.2 };
  return { grade: 'isolated', eta: 1.0 };
}

/**
 * 키 상태 + 누름 이력 버퍼. 키보드(사람)와 AI/튜토리얼(가상 입력)이 동일하게 사용한다.
 * 시간 단위는 초.
 */
export class InputBuffer {
  private readonly state = new Map<ControlKey, KeyState>();
  private readonly history = new Map<ControlKey, number[]>();
  private queue: KeyEvent[] = [];

  constructor() {
    for (const k of ALL_KEYS) {
      this.state.set(k, { down: false, pressedAt: -Infinity, releasedAt: -Infinity });
      this.history.set(k, []);
    }
  }

  /** 반환: 실제로 상태가 바뀌었는가 (이미 눌린 키의 반복 입력은 무시) */
  press(code: ControlKey, time: number): boolean {
    const s = this.state.get(code)!;
    if (s.down) return false;
    s.down = true;
    s.pressedAt = time;
    const h = this.history.get(code)!;
    h.push(time);
    if (h.length > HISTORY_SIZE) h.shift();
    this.queue.push({ code, down: true, time });
    return true;
  }

  release(code: ControlKey, time: number): boolean {
    const s = this.state.get(code)!;
    if (!s.down) return false;
    s.down = false;
    s.releasedAt = time;
    this.queue.push({ code, down: false, time });
    return true;
  }

  releaseAll(time: number): void {
    for (const k of ALL_KEYS) this.release(k, time);
  }

  /** 시간 순으로 정렬된 미처리 이벤트를 꺼낸다 */
  drain(): KeyEvent[] {
    const q = this.queue;
    this.queue = [];
    return q.sort((a, b) => a.time - b.time);
  }

  isDown(code: ControlKey): boolean {
    return this.state.get(code)!.down;
  }

  heldFor(code: ControlKey, now: number): number {
    const s = this.state.get(code)!;
    return s.down ? now - s.pressedAt : 0;
  }

  lastPress(code: ControlKey): number {
    return this.state.get(code)!.pressedAt;
  }

  getState(code: ControlKey): Readonly<KeyState> {
    return this.state.get(code)!;
  }

  /** t 시점에 눌려 있거나 [t-window, t] 안에서 눌렸던 키 */
  isActive(code: ControlKey, t: number, window = COMBO_WINDOW): boolean {
    if (this.isDown(code)) return true;
    return this.pressedWithin(code, t - window, t);
  }

  activeSet(t: number, window = COMBO_WINDOW): Set<ControlKey> {
    const set = new Set<ControlKey>();
    for (const k of ALL_KEYS) if (this.isActive(k, t, window)) set.add(k);
    return set;
  }

  pressedWithin(code: ControlKey, from: number, to: number): boolean {
    return this.history.get(code)!.some((p) => p >= from - EPS && p <= to + EPS);
  }

  /** codes 중 [t-lookback, t] 구간의 가장 최근 누름 시각 */
  latestPress(codes: readonly ControlKey[], t: number, lookback = CHAIN_LOOKBACK): number | null {
    let best: number | null = null;
    for (const c of codes) {
      for (const p of this.history.get(c)!) {
        if (p <= t + EPS && p >= t - lookback - EPS && (best === null || p > best)) best = p;
      }
    }
    return best;
  }
}

/**
 * 사지 입력 시각 tLimb 기준 하체 → 코어 → 사지 연쇄 평가.
 * 하체(WASD/Space) 또는 코어(Q/E) 입력이 없으면 Δt 를 정의할 수 없으므로 Isolated(1.0).
 */
export function evaluateChain(buf: InputBuffer, tLimb: number): ChainEvaluation {
  const tCore = buf.latestPress(CORE_KEYS, tLimb);
  if (tCore === null) {
    return { grade: 'isolated', eta: 1.0, dt1: null, dt2: null, tGround: null, tCore: null, tLimb };
  }
  const dt2 = tLimb - tCore;
  const tGround = buf.latestPress(GROUND_KEYS, tCore);
  if (tGround === null) {
    return { grade: 'isolated', eta: 1.0, dt1: null, dt2, tGround: null, tCore, tLimb };
  }
  const dt1 = tCore - tGround;
  const { grade, eta } = classifyChain(dt1, dt2);
  return { grade, eta, dt1, dt2, tGround, tCore, tLimb };
}

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

/**
 * 브라우저 키보드 → InputBuffer.
 * KeyboardEvent.code 기준이라 한/영 전환·대소문자와 무관하다.
 */
export class ErgonomicInputManager extends InputBuffer {
  /** true 이면 실제 키보드 입력을 무시 (튜토리얼 시범 재생 중) */
  suppressed = false;
  keyboardLocked = false;
  private readonly target: Window;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const code = e.code;
    // 왼쪽 Ctrl 이 눌린 상태의 모든 조합은 브라우저 단축키로 새지 않게 차단 (Ctrl+W/T/N 은 키보드 잠금 시에만 차단 가능)
    if (isControlKey(code) || this.isDown('ControlLeft')) e.preventDefault();
    if (!isControlKey(code) || e.repeat || this.suppressed) return;
    this.press(code, e.timeStamp / 1000);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const code = e.code;
    if (!isControlKey(code)) return;
    e.preventDefault();
    this.release(code, e.timeStamp / 1000);
  };

  /** 포커스를 잃으면 keyup 이 오지 않으므로 모든 키를 해제해 눌림 고착을 막는다 */
  private readonly onBlur = () => this.releaseAll(performance.now() / 1000);
  private readonly onVisibility = () => {
    if (document.hidden) this.onBlur();
  };
  private readonly onFullscreenChange = () => {
    if (!document.fullscreenElement) this.keyboardLocked = false;
  };
  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    // 키보드 잠금이 없을 때 Ctrl+W 로 탭이 닫히는 사고 방지 (브라우저 확인창)
    if (!this.keyboardLocked) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  constructor(target: Window = window) {
    super();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown, { capture: true });
    target.addEventListener('keyup', this.onKeyUp, { capture: true });
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('beforeunload', this.onBeforeUnload);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  /** 전체화면 + Keyboard Lock API (Chrome/Edge). Ctrl+W 같은 시스템 단축키까지 게임이 받는다. */
  async lockKeyboard(): Promise<boolean> {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
      if (!kb || typeof kb.lock !== 'function') return false;
      await kb.lock();
      this.keyboardLocked = true;
      return true;
    } catch {
      this.keyboardLocked = false;
      return false;
    }
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown, { capture: true });
    this.target.removeEventListener('keyup', this.onKeyUp, { capture: true });
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('beforeunload', this.onBeforeUnload);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}
