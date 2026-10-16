// 실시간 무술 텔레메트리 HUD: 양손 키보드 오버레이 · 운동 사슬 분석기 · 기술 로그 · 가이드
import { AIMode, AI_MODE_LABELS } from '../ai/SparringPartnerAI';
import type { CombatWorld } from '../combat/CombatWorld';
import { MAX_HP } from '../combat/FighterController';
import type { ErgonomicInputManager } from '../input/ErgonomicInputManager';
import type { RenderOptions } from '../render/SceneRenderer';
import type { ChainGrade, ChainTelemetry, ControlKey, HitZone, TrajectoryShape, WorldEvent } from '../types/combat';
import { GUIDE, TutorialController } from './TutorialController';

type KeyRole = 'ground' | 'core' | 'level' | 'limb' | 'mod' | 'grab';

interface KeyDef {
  code: ControlKey;
  cap: string;
  label: string;
  role: KeyRole;
  part: string; // 활성 신체 부위
  wide?: number;
}

const LEFT_ROWS: KeyDef[][] = [
  [
    { code: 'KeyQ', cap: 'Q', label: '코어 좌회전', role: 'core', part: '코어(오른쪽 투입)' },
    { code: 'KeyW', cap: 'W', label: '전진 스텝', role: 'ground', part: '하체 보법' },
    { code: 'KeyE', cap: 'E', label: '코어 우회전', role: 'core', part: '코어(왼쪽 투입)' },
  ],
  [
    { code: 'KeyA', cap: 'A', label: '좌 스텝', role: 'ground', part: '하체 보법' },
    { code: 'KeyS', cap: 'S', label: '후진 스텝', role: 'ground', part: '하체 보법' },
    { code: 'KeyD', cap: 'D', label: '우 스텝', role: 'ground', part: '하체 보법' },
  ],
  [{ code: 'ShiftLeft', cap: 'Shift', label: '무게중심 하강', role: 'level', part: '골반 하강', wide: 2 }],
  [
    { code: 'ControlLeft', cap: 'Ctrl', label: '뒷발 체중', role: 'level', part: '뒷발 중심', wide: 1.3 },
    { code: 'Space', cap: 'Space', label: '지면 반발', role: 'ground', part: '지면 반발력', wide: 2.6 },
  ],
];

const RIGHT_ROWS: KeyDef[][] = [
  [
    { code: 'KeyU', cap: 'U', label: '왼팔 신전', role: 'limb', part: '왼팔' },
    { code: 'KeyI', cap: 'I', label: '오른팔 신전', role: 'limb', part: '오른팔' },
    { code: 'KeyO', cap: 'O', label: '수직 궤적', role: 'mod', part: '수직 궤적' },
  ],
  [
    { code: 'KeyJ', cap: 'J', label: '왼발 신전', role: 'limb', part: '왼발' },
    { code: 'KeyK', cap: 'K', label: '오른발 신전', role: 'limb', part: '오른발' },
    { code: 'KeyL', cap: 'L', label: '수평 궤적', role: 'mod', part: '수평 궤적' },
    { code: 'Semicolon', cap: ';', label: '접기/가드', role: 'mod', part: '관절 접기' },
  ],
  [{ code: 'KeyM', cap: 'M', label: '파지/클린치', role: 'grab', part: '파지' }],
];

const GRADE_LABEL: Record<ChainGrade, string> = {
  perfect: 'PERFECT CHAIN ×1.5',
  simultaneous: 'SIMULTANEOUS ×1.2',
  isolated: 'ISOLATED ×1.0',
};
const SHAPE_LABEL: Record<TrajectoryShape, string> = {
  straight: '직선',
  horizontal: '수평 원호',
  verticalUp: '아래→위',
  verticalDown: '위→아래',
  overTop: '물음표(오버탑)',
};
const ZONE_LABEL: Record<HitZone, string> = { head: '머리', body: '몸통', liver: '간(리버)', leg: '다리' };
const STATUS_LABEL = { normal: '정상', hitstun: '피격 경직', stumble: '비틀거림', knockdown: '다운', ko: 'K.O.' } as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const fmtMs = (dt: number | null) => (dt === null ? '—' : `${Math.round(dt * 1000)}ms`);

export class CombatHUD {
  private readonly root: HTMLElement;
  private readonly keyEls = new Map<ControlKey, HTMLElement>();
  private readonly partsEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly oppStatus: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerName: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly log: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly analyzer: Record<string, HTMLElement> = {};
  private readonly modeButtons = new Map<AIMode, HTMLButtonElement>();
  private readonly lockBtn: HTMLButtonElement;
  private readonly lockNote: HTMLElement;
  private readonly guideItems = new Map<string, HTMLElement>();
  private readonly practiceBox: HTMLElement;
  private readonly practiceContent: HTMLElement;
  private practiceHtml = '';
  private bannerAt = -Infinity;
  private flashAt = -Infinity;

  constructor(
    parent: HTMLElement,
    private readonly world: CombatWorld,
    private readonly input: ErgonomicInputManager,
    private readonly tutorial: TutorialController,
    private readonly renderOpts: RenderOptions,
    private readonly clock: () => number,
  ) {
    this.root = el('div', 'hud');
    parent.appendChild(this.root);

    // ── 상단 바 ──
    const top = el('div', 'topbar panel');
    top.appendChild(el('div', 'title', 'KINETIC <b>ARTS</b><small>운동 사슬 절차적 무술</small>'));
    const modes = el('div', 'modes');
    for (const mode of Object.keys(AI_MODE_LABELS) as AIMode[]) {
      const b = el('button', 'btn', AI_MODE_LABELS[mode]);
      b.addEventListener('click', () => {
        this.tutorial.stop(this.clock());
        this.world.setMode(mode, this.clock());
        b.blur();
      });
      this.modeButtons.set(mode, b);
      modes.appendChild(b);
    }
    top.appendChild(modes);
    const tools = el('div', 'tools');
    const reset = el('button', 'btn ghost', '위치 리셋');
    reset.addEventListener('click', () => {
      this.world.resetPositions();
      reset.blur();
    });
    const tBos = el('button', 'btn ghost toggle on', 'BoS/CoM');
    tBos.addEventListener('click', () => {
      this.renderOpts.showBalance = !this.renderOpts.showBalance;
      tBos.classList.toggle('on', this.renderOpts.showBalance);
      tBos.blur();
    });
    const tCurve = el('button', 'btn ghost toggle on', '베지어');
    tCurve.addEventListener('click', () => {
      this.renderOpts.showCurves = !this.renderOpts.showCurves;
      tCurve.classList.toggle('on', this.renderOpts.showCurves);
      tCurve.blur();
    });
    this.lockBtn = el('button', 'btn accent', '전체화면 + 키 잠금');
    this.lockBtn.addEventListener('click', async () => {
      const ok = await this.input.lockKeyboard();
      this.lockNote.textContent = ok ? '' : '이 브라우저는 키보드 잠금을 지원하지 않습니다 (Chrome/Edge 권장)';
      this.lockBtn.blur();
    });
    tools.append(reset, tBos, tCurve, this.lockBtn);
    top.appendChild(tools);
    this.root.appendChild(top);

    // ── 상대 HP ──
    const hp = el('div', 'hp panel');
    hp.appendChild(el('div', 'hp-label', '상대 HP'));
    const bar = el('div', 'hp-bar');
    this.hpFill = el('div', 'hp-fill');
    bar.appendChild(this.hpFill);
    hp.appendChild(bar);
    this.hpText = el('div', 'hp-text', '100');
    this.oppStatus = el('div', 'hp-status', '정상');
    hp.append(this.hpText, this.oppStatus);
    this.root.appendChild(hp);

    // ── 기술 배너 + 로그 ──
    this.banner = el('div', 'banner');
    this.bannerName = el('div', 'banner-name');
    this.bannerSub = el('div', 'banner-sub');
    this.banner.append(this.bannerName, this.bannerSub);
    this.root.appendChild(this.banner);
    this.log = el('div', 'log');
    this.root.appendChild(this.log);
    this.flash = el('div', 'flash');
    this.root.appendChild(this.flash);

    // ── 운동 사슬 분석기 ──
    const an = el('div', 'analyzer panel');
    an.appendChild(el('h3', '', '운동 사슬 분석기 <small>Kinetic Chain</small>'));
    const tech = el('div', 'an-tech');
    an.appendChild(tech);
    this.analyzer.tech = tech;
    const grade = el('div', 'an-grade');
    an.appendChild(grade);
    this.analyzer.grade = grade;
    const stage = (key: string, num: string, title: string) => {
      const row = el('div', 'stage');
      row.appendChild(el('div', 'stage-num', num));
      const body = el('div', 'stage-body');
      const head = el('div', 'stage-head');
      head.appendChild(el('span', 'stage-title', title));
      const val = el('span', 'stage-val', '—');
      head.appendChild(val);
      const barO = el('div', 'bar');
      const barI = el('div', 'bar-fill');
      barO.appendChild(barI);
      const note = el('div', 'stage-note', '');
      body.append(head, barO, note);
      row.appendChild(body);
      an.appendChild(row);
      this.analyzer[key + 'Val'] = val;
      this.analyzer[key + 'Bar'] = barI;
      this.analyzer[key + 'Note'] = note;
      return row;
    };
    stage('ground', '①', '하체 지면 반발 |v_step|').classList.add('s-ground');
    stage('core', '②', '코어 회전 |ω×r|').classList.add('s-core');
    stage('limb', '③', '사지 궤적 |v_limb|').classList.add('s-limb');
    stage('impact', '④', '최종 충격량 I_impact').classList.add('s-impact');
    const formula = el('div', 'formula');
    an.appendChild(formula);
    this.analyzer.formula = formula;
    an.appendChild(el('h4', '', '밸런스 (CoM / BoS)'));
    const bal = el('div', 'balance');
    const ratioBar = el('div', 'bar ratio');
    const ratioFill = el('div', 'bar-fill');
    ratioBar.append(ratioFill, el('div', 'ratio-mark'));
    const instBar = el('div', 'bar inst');
    const instFill = el('div', 'bar-fill');
    instBar.appendChild(instFill);
    const balText = el('div', 'stage-note');
    bal.append(el('div', 'mini', 'StabilityRatio'), ratioBar, el('div', 'mini', '불안정 누적'), instBar, balText);
    an.appendChild(bal);
    this.analyzer.ratioFill = ratioFill;
    this.analyzer.instFill = instFill;
    this.analyzer.balText = balText;
    this.root.appendChild(an);

    // ── 기술 가이드 ──
    const guide = el('div', 'guide panel');
    guide.appendChild(el('h3', '', '기술 가이드 <small>클릭: 시범 → 따라 치기</small>'));
    for (const g of GUIDE) {
      const item = el('div', 'guide-item');
      item.appendChild(el('div', 'g-title', `${g.title} <small>${g.en}</small>`));
      item.appendChild(el('div', 'g-seq', g.sequence.map((s) => `<kbd>${s}</kbd>`).join('<i>→</i>')));
      item.appendChild(el('div', 'g-desc', g.desc));
      const btns = el('div', 'g-btns');
      const demo = el('button', 'btn small accent', '▶ 시범');
      demo.addEventListener('click', () => {
        this.tutorial.startDemo(g, this.clock());
        demo.blur();
      });
      const prac = el('button', 'btn small', '따라 치기');
      prac.addEventListener('click', () => {
        this.tutorial.startPractice(g, this.clock());
        prac.blur();
      });
      btns.append(demo, prac);
      item.appendChild(btns);
      guide.appendChild(item);
      this.guideItems.set(g.id, item);
    }
    this.practiceBox = el('div', 'practice');
    this.practiceContent = el('div');
    const stop = el('button', 'btn small ghost', '연습 종료');
    stop.addEventListener('click', () => {
      this.tutorial.stop(this.clock());
      stop.blur();
    });
    this.practiceBox.append(this.practiceContent, stop);
    guide.appendChild(this.practiceBox);
    this.root.appendChild(guide);

    // ── 키보드 오버레이 ──
    const kb = el('div', 'keyboard panel');
    const hand = (rows: KeyDef[][], title: string, cls: string) => {
      const h = el('div', `hand ${cls}`);
      h.appendChild(el('div', 'hand-title', title));
      for (const row of rows) {
        const r = el('div', 'krow');
        for (const k of row) {
          const key = el('div', `key r-${k.role}`);
          key.style.flexGrow = String(k.wide ?? 1);
          key.innerHTML = `<b>${k.cap}</b><span>${k.label}</span>`;
          key.dataset.part = k.part;
          this.keyEls.set(k.code, key);
          r.appendChild(key);
        }
        h.appendChild(r);
      }
      return h;
    };
    kb.appendChild(hand(LEFT_ROWS, '왼손 · 하체 / 무게중심 / 코어', 'left'));
    const mid = el('div', 'kb-mid');
    this.partsEl = el('div', 'parts', '');
    mid.appendChild(el('div', 'mini', '활성 신체 부위'));
    mid.appendChild(this.partsEl);
    this.lockNote = el('div', 'lock-note', '');
    mid.appendChild(this.lockNote);
    kb.appendChild(mid);
    kb.appendChild(hand(RIGHT_ROWS, '오른손 · 사지 신전 / 궤적', 'right'));
    this.root.appendChild(kb);

    this.root.appendChild(el('div', 'help', '마우스 드래그: 카메라 회전 · 휠: 줌 · 키는 KeyboardEvent.code 기준 (한/영 무관)'));
  }

  // ───────── 이벤트 → 로그 / 배너 / 플래시 ─────────
  handleEvents(events: WorldEvent[], now: number): void {
    for (const e of events) {
      switch (e.type) {
        case 'technique': {
          if (e.fighter === 'player') {
            if (e.technique.id === 'guard' && !e.updated) {
              this.addLog(`🛡 ${e.technique.nameKo}`, 'dim');
              break;
            }
            this.showBanner(e.technique.nameKo, e.technique.name, e.telemetry, now);
            const g = e.telemetry.chain.grade;
            const prefix = e.updated ? '↳ 페인트 변환: ' : '';
            this.addLog(`${prefix}<b>${e.technique.nameKo}</b> ${e.technique.name} <em class="g-${g}">${GRADE_LABEL[g]}</em>`, e.updated ? 'feint' : '');
          } else if (e.technique.id !== 'guard') {
            this.addLog(`상대: ${e.technique.nameKo}`, 'opp');
          }
          break;
        }
        case 'hit': {
          const zone = ZONE_LABEL[e.zone];
          if (e.attacker === 'player') {
            this.addLog(e.blocked
              ? `가드에 막힘 · ${zone} · I=${e.impulse.toFixed(1)} · -${e.damage.toFixed(1)}`
              : `<b>적중!</b> ${zone} · I=${e.impulse.toFixed(1)} · 데미지 ${e.damage.toFixed(1)}`, e.blocked ? 'dim' : 'hit');
          } else {
            this.addLog(e.blocked ? `상대 ${e.technique.nameKo} 가드 성공` : `피격: 상대 ${e.technique.nameKo} (${zone})`, e.blocked ? 'dim' : 'opp');
          }
          if (e.counter) this.showFlash('COUNTER DOWN', 'counter', now);
          break;
        }
        case 'parry':
          this.addLog(e.fighter === 'player' ? '<b>패링 성공!</b>' : '상대가 패링했다', e.fighter === 'player' ? 'hit' : 'opp');
          if (e.fighter === 'player') this.showFlash('PARRY!', 'parry', now);
          break;
        case 'grab':
          if (e.fighter === 'player') this.addLog(e.part === 'miss' ? '파지 실패 (거리)' : `파지 성공: ${{ neck: '목 클린치', wrist: '손목', leg: '하체' }[e.part]}`, e.part === 'miss' ? 'dim' : '');
          break;
        case 'takedown':
          if (e.fighter === 'player') {
            this.addLog(e.success ? `<b>테이크다운 성공!</b> I=${e.impulse.toFixed(1)}` : '테이크다운 실패 (거리)', e.success ? 'hit' : 'dim');
            if (e.success) this.showFlash('TAKEDOWN!', 'counter', now);
          }
          break;
        case 'stumble':
          this.addLog(e.fighter === 'player' ? '비틀거림! 무게중심이 지지면을 벗어남 (0.6s 입력 페널티)' : '상대 비틀거림', 'warn');
          if (e.fighter === 'player') this.showFlash('STUMBLE', 'warn', now);
          break;
        case 'ko':
          this.addLog(e.fighter === 'opponent' ? '<b>K.O.!</b>' : '플레이어 다운', 'hit');
          if (e.fighter === 'opponent') this.showFlash('K.O.', 'ko', now);
          break;
        case 'knockdown':
          if (e.fighter === 'player') this.addLog('플레이어 다운!', 'opp');
          break;
        case 'telegraph':
          this.addLog('상대 공격 예고 — ; 가드 / ;+U 패링 준비', 'warn');
          break;
        default:
          break;
      }
    }
  }

  private addLog(html: string, cls: string): void {
    const line = el('div', `log-line ${cls}`, html);
    this.log.prepend(line);
    while (this.log.childElementCount > 7) this.log.lastElementChild?.remove();
  }

  private showBanner(ko: string, en: string, t: ChainTelemetry, now: number): void {
    this.bannerName.textContent = ko;
    this.bannerSub.innerHTML = `${en} · <em class="g-${t.chain.grade}">${GRADE_LABEL[t.chain.grade]}</em>`;
    this.bannerAt = now;
  }

  private showFlash(text: string, cls: string, now: number): void {
    this.flash.textContent = text;
    this.flash.className = `flash show ${cls}`;
    this.flashAt = now;
  }

  // ───────── 프레임 갱신 ─────────
  update(now: number): void {
    const p = this.world.player;
    const o = this.world.opponent;

    for (const [mode, b] of this.modeButtons) b.classList.toggle('active', this.world.ai.mode === mode);

    // 키 하이라이트 + 활성 부위
    const parts = new Set<string>();
    for (const [code, key] of this.keyEls) {
      const down = p.input.isDown(code);
      key.classList.toggle('down', down);
      if (down) parts.add(key.dataset.part ?? '');
    }
    for (const s of p.strikes.values()) {
      if (s.phase !== 'retract') parts.add(`${{ fist: '주먹', elbow: '팔꿈치', foot: '발', knee: '무릎' }[s.striker]} 타격`);
    }
    if (p.guardUp) parts.add('가드');
    if (p.clinch) parts.add('클린치');
    this.partsEl.innerHTML = parts.size ? [...parts].map((x) => `<span>${x}</span>`).join('') : '<span class="dim">—</span>';

    // 키보드 잠금 상태
    this.lockBtn.classList.toggle('locked', this.input.keyboardLocked);
    this.lockBtn.textContent = this.input.keyboardLocked ? '키 잠금 활성' : '전체화면 + 키 잠금';
    if (!this.input.keyboardLocked && !this.lockNote.textContent) {
      this.lockNote.textContent = 'Ctrl+W 는 탭을 닫을 수 있습니다 → 전체화면 키 잠금 권장';
    } else if (this.input.keyboardLocked) {
      this.lockNote.textContent = '';
    }

    // HP
    const hpRatio = o.hp / MAX_HP;
    this.hpFill.style.width = `${hpRatio * 100}%`;
    this.hpFill.classList.toggle('low', hpRatio < 0.3);
    this.hpText.textContent = o.hp.toFixed(0);
    this.oppStatus.textContent = STATUS_LABEL[o.status];
    this.oppStatus.className = `hp-status st-${o.status}`;

    this.banner.style.opacity = String(Math.max(0, 1 - (now - this.bannerAt - 0.9) / 0.6));
    if (now - this.flashAt > 0.9) this.flash.classList.remove('show');

    this.updateAnalyzer();
    this.updateGuide(now);
  }

  private updateAnalyzer(): void {
    const p = this.world.player;
    const t = p.telemetry;
    const a = this.analyzer;
    const setBar = (key: string, v: number, max: number) => {
      a[key + 'Bar'].style.width = `${Math.min(100, (v / max) * 100)}%`;
    };
    if (t) {
      a.tech.innerHTML = `${t.technique.nameKo} <small>${t.technique.name}</small>`;
      a.grade.className = `an-grade g-${t.chain.grade}`;
      a.grade.textContent = GRADE_LABEL[t.chain.grade];
      a.groundVal.textContent = `${t.vStep.toFixed(2)} m/s`;
      a.groundNote.textContent = `Δt₁ (하체→코어) = ${fmtMs(t.chain.dt1)}`;
      setBar('ground', t.vStep, 5);
      a.coreVal.textContent = `${t.vRot.toFixed(2)} m/s`;
      a.coreNote.textContent = `ω = ${t.omega.toFixed(1)} rad/s · Δt₂ (코어→사지) = ${fmtMs(t.chain.dt2)}`;
      setBar('core', t.vRot, 4);
      a.limbVal.textContent = `${t.vLimb.toFixed(2)} m/s`;
      a.limbNote.textContent = `궤적: ${SHAPE_LABEL[t.shape]} · 타격점: ${{ fist: '주먹', elbow: '팔꿈치', foot: '발', knee: '무릎' }[t.striker]}`;
      setBar('limb', t.vLimb, 9);
      a.impactVal.textContent = t.impulse.toFixed(1);
      a.impactNote.innerHTML = t.final ? `<b>적중 확정</b> · ${t.zone ? ZONE_LABEL[t.zone] : ''}` : '신전 중 예상치';
      setBar('impact', t.impulse, 25);
      const mf = t.massFactors.map((f) => `${f.label} ×${f.value}`).join(' · ') || '—';
      a.formula.innerHTML =
        `<div>I = η · m<sub>eff</sub> · ‖v<sub>step</sub> + ω×r + v<sub>limb</sub>‖</div>` +
        `<div>= ${t.chain.eta.toFixed(1)} × ${t.mEff.toFixed(2)} × ‖…‖ = <b>${t.impulse.toFixed(1)}</b></div>` +
        `<div class="mini">m<sub>eff</sub>: ${mf}</div>`;
    } else {
      a.tech.innerHTML = '<span class="dim">사지 키(U/I/J/K)를 눌러 보세요</span>';
      a.grade.textContent = '';
      for (const k of ['ground', 'core', 'limb', 'impact']) {
        a[k + 'Val'].textContent = '—';
        a[k + 'Note'].textContent = '';
        setBar(k, 0, 1);
      }
      a.formula.innerHTML = '<div>I = η · m<sub>eff</sub> · ‖v<sub>step</sub> + ω×r + v<sub>limb</sub>‖</div>';
    }
    const ratio = Number.isFinite(p.balance.ratio) ? p.balance.ratio : 3;
    a.ratioFill.style.width = `${Math.min(100, (ratio / 2) * 100)}%`;
    a.ratioFill.className = `bar-fill ${ratio > 1 ? 'bad' : ratio > 0.7 ? 'mid' : 'good'}`;
    a.instFill.style.width = `${Math.min(100, p.monitor.instability * 100)}%`;
    const st = p.status === 'normal' ? '' : ` · <b>${STATUS_LABEL[p.status]}</b> ${(p.statusDur - p.statusT).toFixed(1)}s`;
    a.balText.innerHTML = `ratio ${ratio.toFixed(2)} · 지지면 ${{ capsule: '양발 캡슐', circle: '한 발 원', none: '없음' }[p.balance.bos.kind]}${st}`;
  }

  private updateGuide(now: number): void {
    const tut = this.tutorial;
    for (const [id, item] of this.guideItems) item.classList.toggle('selected', tut.entry?.id === id);
    let cls = 'practice';
    let html = '';
    if (tut.mode !== 'idle' && tut.entry) {
      const e = tut.entry;
      const chips = [...new Set(e.script.map(([code]) => code))]
        .map((code) => `<kbd class="${this.world.player.input.isDown(code) ? 'down' : ''}">${code.replace('Key', '').replace('Left', '').replace('Semicolon', ';')}</kbd>`)
        .join('');
      if (tut.mode === 'demo') {
        cls = 'practice show demo';
        html = `<b>▶ 시범 재생 중</b> · ${e.title}<div class="chips">${chips}</div><div class="mini">시범이 끝나면 따라 치기로 전환됩니다</div>`;
      } else {
        const ok = now - tut.lastSuccessAt < 1.2;
        cls = `practice show ${ok ? 'ok' : ''}`;
        html =
          `<b>따라 치기:</b> ${e.title} <small>${e.en}</small>` +
          `<div class="g-seq">${e.sequence.map((s) => `<kbd>${s}</kbd>`).join('<i>→</i>')}</div>` +
          `<div class="chips">${chips}</div>` +
          `<div>성공 <b>${tut.successes}</b>회${ok ? ' · <b class="okt">성공!</b>' : ''}</div>` +
          (tut.lastAttempt ? `<div class="mini">방금 발현: ${tut.lastAttempt}</div>` : '');
      }
    }
    if (this.practiceBox.className !== cls) this.practiceBox.className = cls;
    if (html !== this.practiceHtml) {
      this.practiceContent.innerHTML = html;
      this.practiceHtml = html;
    }
  }
}
