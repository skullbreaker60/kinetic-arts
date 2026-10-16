import { describe, expect, it } from 'vitest';
import { CombatWorld, FIXED_DT } from '../src/combat/CombatWorld';
import { JOINT_NAMES, type ControlKey, type TechniqueId } from '../src/types/combat';
import { hits, runScript, Step, techniques } from './simHelpers';

/** 판정표 14개 중 타격 기술: 기대 기술명 + 적중 여부 */
const TECHNIQUE_SCRIPTS: { id: TechniqueId; steps: Step[] }[] = [
  { id: 'jab', steps: [['KeyU', 0.2, 0.08]] },
  { id: 'rightCross', steps: [['Space', 0.2, 0.06], ['KeyQ', 0.29, 0.15], ['KeyI', 0.38, 0.08]] },
  { id: 'leftHook', steps: [['KeyW', 0.1, 0.08], ['KeyE', 0.18, 0.2], ['KeyL', 0.2, 0.3], ['KeyU', 0.27, 0.08]] },
  { id: 'leftLiverHook', steps: [['ShiftLeft', 0, 0.8], ['KeyW', 0.2, 0.08], ['KeyE', 0.29, 0.2], ['KeyL', 0.32, 0.3], ['KeyU', 0.39, 0.08]] },
  { id: 'rightUppercut', steps: [['ShiftLeft', 0, 0.8], ['KeyW', 0.2, 0.08], ['KeyQ', 0.29, 0.2], ['KeyO', 0.32, 0.3], ['KeyI', 0.39, 0.08]] },
  { id: 'spinningBackfist', steps: [['KeyE', 0, 0.5], ['KeyL', 0.3, 0.3], ['KeyU', 0.38, 0.08]] },
  { id: 'horizontalElbow', steps: [['KeyW', 0, 0.4], ['KeyQ', 0.35, 0.2], ['Semicolon', 0.37, 0.3], ['KeyL', 0.37, 0.3], ['KeyI', 0.42, 0.08]] },
  { id: 'teep', steps: [['ControlLeft', 0, 0.8], ['KeyJ', 0.3, 0.1]] },
  { id: 'roundhouse', steps: [['Space', 0.2, 0.06], ['KeyQ', 0.27, 0.2], ['KeyL', 0.3, 0.3], ['KeyK', 0.35, 0.1]] },
  { id: 'brazilianKick', steps: [['KeyK', 0.2, 0.1], ['KeyQ', 0.28, 0.2], ['KeyL', 0.28, 0.2]] },
  { id: 'spinningBackKick', steps: [['KeyQ', 0, 0.5], ['Space', 0.15, 0.06], ['KeyK', 0.4, 0.1]] },
  { id: 'clinchKnee', steps: [['KeyW', 0, 0.3], ['KeyM', 0.35, 1.2], ['Semicolon', 0.8, 0.4], ['KeyO', 0.8, 0.4], ['KeyK', 0.9, 0.1]] },
];

describe('기술 발현 + 적중 (헤드리스 시뮬레이션)', () => {
  for (const { id, steps } of TECHNIQUE_SCRIPTS) {
    it(`${id}: 판정되고, 적중하고, 비틀거리지 않는다`, () => {
      const w = new CombatWorld();
      const r = runScript(w, w.player, steps, 2, 10);
      expect(techniques(r)).toContain(id);
      expect(hits(r).length).toBeGreaterThanOrEqual(1);
      expect(r.events.some((e) => e.type === 'stumble' && e.fighter === 'player')).toBe(false);
    });
  }

  it('더블 렉 테이크다운: 성공 → 상대 다운', () => {
    const w = new CombatWorld();
    const r = runScript(w, w.player, [['ShiftLeft', 0, 0.9], ['KeyW', 0.05, 0.6], ['Space', 0.12, 0.06], ['KeyU', 0.2, 0.4], ['KeyI', 0.2, 0.4], ['KeyM', 0.2, 0.4]], 1.0, 10);
    expect(techniques(r)).toContain('doubleLegTakedown');
    expect(r.events.some((e) => e.type === 'takedown' && e.success)).toBe(true);
    expect(w.opponent.status).toBe('knockdown');
    // 동시 입력된 U/I 가 별도 펀치로 새지 않는다
    expect(techniques(r).filter((t) => t === 'jab' || t === 'freeform')).toHaveLength(0);
  });

  it('더블 렉 테이크다운: 거리가 멀면 실패', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [['KeyS', 0, 0.8]], 1.0, 10);
    const r = runScript(w, w.player, [['ShiftLeft', 0, 0.6], ['KeyW', 0.0, 0.1], ['Space', 0.02, 0.04], ['KeyU', 0.05, 0.3], ['KeyI', 0.05, 0.3], ['KeyM', 0.05, 0.3]], 1.0, 11);
    expect(r.events.some((e) => e.type === 'takedown' && !e.success)).toBe(true);
    expect(w.opponent.status).toBe('normal');
  });
});

describe('운동 사슬 효과', () => {
  it('Perfect Chain + 지면 반발 크로스 > 고립 크로스 > 잽', () => {
    const imp = (steps: Step[]) => {
      const w = new CombatWorld();
      return hits(runScript(w, w.player, steps, 1.5, 10))[0]?.impulse ?? 0;
    };
    const perfect = imp([['Space', 0.2, 0.06], ['KeyQ', 0.29, 0.15], ['KeyI', 0.38, 0.08]]);
    const isolated = imp([['KeyQ', 0.2, 0.15], ['KeyI', 0.3, 0.08]]);
    const jab = imp([['KeyU', 0.2, 0.08]]);
    expect(perfect).toBeGreaterThan(isolated * 1.5);
    expect(isolated).toBeGreaterThan(jab);
  });

  it('텔레메트리: Perfect 판정과 m_eff = 1.4 × 1.3', () => {
    const w = new CombatWorld();
    const r = runScript(w, w.player, [['Space', 0.2, 0.06], ['KeyQ', 0.29, 0.15], ['KeyI', 0.38, 0.08]], 1.0, 10);
    const tech = r.events.find((e) => e.type === 'technique' && e.technique.id === 'rightCross');
    expect(tech && tech.type === 'technique' && tech.telemetry.chain.grade).toBe('perfect');
    expect(w.player.telemetry?.mEff).toBeCloseTo(1.82);
    expect(w.player.telemetry?.final).toBe(true);
  });
});

describe('실시간 페인트 (u ≤ 0.45)', () => {
  it('잽 → 훅 변환: U 후 u≈0.3 에 L', () => {
    const w = new CombatWorld();
    const r = runScript(w, w.player, [['KeyU', 0.2, 0.1], ['KeyL', 0.245, 0.2]], 0.3, 10);
    const s = w.player.strikes.get('leftArm');
    expect(s?.flags.horizontal).toBe(true);
    expect(s?.feints.length).toBe(1);
    expect(r.events.some((e) => e.type === 'technique' && e.updated)).toBe(true);
  });
  it('u > 0.45 이후 입력은 페인트로 처리되지 않음', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [['KeyU', 0.2, 0.1], ['KeyL', 0.3, 0.2]], 0.33, 10);
    const s = w.player.strikes.get('leftArm');
    expect(s?.flags.horizontal).toBe(false);
  });
  it('브라질리언 킥은 Q+L 이 u∈[0.15,0.45] 일 때만 (너무 이르면 아님)', () => {
    const w = new CombatWorld();
    const r = runScript(w, w.player, [['KeyK', 0.2, 0.1], ['KeyQ', 0.21, 0.2], ['KeyL', 0.21, 0.2]], 1.0, 10);
    expect(techniques(r)).not.toContain('brazilianKick');
  });
});

describe('밸런스 / 비틀거림 / 다운', () => {
  it('무리한 연속 스핀 + 대시 킥 → Stumble', () => {
    const w = new CombatWorld();
    const r = runScript(w, w.player, [['KeyQ', 0, 1.6], ['Space', 0.5, 0.06], ['KeyL', 0.5, 0.5], ['KeyK', 0.55, 0.1], ['Space', 0.9, 0.06], ['KeyJ', 0.95, 0.1]], 2.0, 10);
    expect(r.maxRatio).toBeGreaterThan(1);
    expect(r.events.some((e) => e.type === 'stumble' && e.fighter === 'player')).toBe(true);
  });
  it('Stumble 중에는 입력 페널티 (사지 신전 무시)', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [], 0.1, 10);
    w.player.setStatus('stumble', 0.6);
    runScript(w, w.player, [['KeyU', 0.05, 0.08]], 0.2, 10.1);
    expect(w.player.strikes.size).toBe(0);
  });
  it('비틀거리는 상대를 때리면 카운터 다운', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [], 0.1, 10);
    w.opponent.setStatus('stumble', 0.6);
    const r = runScript(w, w.player, [['KeyU', 0.02, 0.08]], 0.4, 10.1);
    expect(r.events.some((e) => e.type === 'hit' && e.counter)).toBe(true);
    expect(w.opponent.status).toBe('knockdown');
  });
  it('HP 0 → KO → 일정 시간 후 HP 회복 및 기상', () => {
    const w = new CombatWorld();
    w.opponent.hp = 2;
    const r = runScript(w, w.player, [['Space', 0.2, 0.06], ['KeyQ', 0.29, 0.15], ['KeyI', 0.38, 0.08]], 0.8, 10);
    expect(r.events.some((e) => e.type === 'ko')).toBe(true);
    expect(w.opponent.status).toBe('ko');
    const r2 = runScript(w, w.player, [], 3.5, 10.8);
    expect(r2.events.some((e) => e.type === 'recover')).toBe(true);
    expect(w.opponent.hp).toBe(100);
    expect(w.opponent.status).toBe('normal');
  });
  it('다운된 상대에게는 추가 적중 없음', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [], 0.1, 10);
    w.opponent.setStatus('stumble', 0.6);
    runScript(w, w.player, [['KeyU', 0.02, 0.08]], 0.4, 10.1);
    const r = runScript(w, w.player, [['KeyU', 0.1, 0.08], ['KeyI', 0.3, 0.08]], 0.8, 10.5);
    expect(hits(r)).toHaveLength(0);
  });
});

describe('가드 / 패링 / 파지', () => {
  it('상대가 ; 가드 중이면 정면 잽은 막힌다 (데미지 25%)', () => {
    const open = new CombatWorld();
    const d0 = hits(runScript(open, open.player, [['KeyU', 0.2, 0.08]], 1, 10))[0];
    const w = new CombatWorld();
    w.opponent.input.press('Semicolon', 10);
    const d1 = hits(runScript(w, w.player, [['KeyU', 0.2, 0.08]], 1, 10))[0];
    expect(d1.blocked).toBe(true);
    expect(d1.damage).toBeLessThan(d0.damage * 0.5);
  });
  it('패링: 가드 상태에서 공격 직전 단발 신전 → 상대 타격 취소 + 경직', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [], 0.2, 10);
    w.opponent.input.press('Semicolon', 10.2);
    // 플레이어 잽(0.15s) 발사 후 u≈0.5 시점에 상대가 U
    const sched: Step[] = [['KeyU', 0.05, 0.08]];
    const r = (() => {
      const evs = runScript(w, w.player, sched, 0.125, 10.2);
      w.opponent.input.press('KeyU', 10.2 + 0.125);
      const more = runScript(w, w.player, [], 0.5, 10.2 + 0.125);
      return [...evs.events, ...more.events];
    })();
    expect(r.some((e) => e.type === 'parry' && e.fighter === 'opponent')).toBe(true);
    expect(r.some((e) => e.type === 'hit' && e.attacker === 'player')).toBe(false);
  });
  it('파지: 너무 멀면 Miss', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [['KeyS', 0, 0.6]], 0.8, 10);
    const r = runScript(w, w.player, [['KeyM', 0.05, 0.3]], 0.5, 10.8);
    expect(r.events.some((e) => e.type === 'grab' && e.part === 'miss')).toBe(true);
    expect(w.player.clinch).toBeNull();
  });
  it('파지: 상대 팔이 뻗어 있을 때 M → 손목 파지 + 상대 타격 취소', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [], 0.2, 10);
    w.opponent.input.press('KeyU', 10.2);
    const r = runScript(w, w.player, [['KeyM', 0.1, 0.5]], 0.3, 10.2);
    expect(r.events.some((e) => e.type === 'grab' && e.part === 'wrist')).toBe(true);
    expect(w.opponent.heldWrist?.by).toBe(w.player);
  });
  it('클린치는 M 을 떼면 해제', () => {
    const w = new CombatWorld();
    runScript(w, w.player, [['KeyW', 0, 0.3], ['KeyM', 0.35, 5]], 0.6, 10);
    expect(w.player.clinch?.part).toBe('neck');
    w.player.input.release('KeyM', 10.6);
    runScript(w, w.player, [], 0.3, 10.6);
    expect(w.player.clinch).toBeNull();
    expect(w.opponent.clinchedBy).toBeNull();
  });
});

describe('스파링 파트너 AI', () => {
  it('능동형 스파링 AI: 20초 동안 공격을 시도하고 적중시킨다', () => {
    const w = new CombatWorld(3);
    w.setMode('sparring', 10);
    const r = runScript(w, w.player, [], 20, 10);
    expect(r.events.filter((e) => e.type === 'technique' && e.fighter === 'opponent').length).toBeGreaterThan(5);
    expect(hits(r, 'opponent').length).toBeGreaterThan(0);
  });
  it('가드 & 패링 더미: 예고(telegraph) 후 공격, 평소에는 가드 유지', () => {
    const w = new CombatWorld(3);
    w.setMode('guardDummy', 10);
    const r = runScript(w, w.player, [], 6, 10);
    expect(r.events.some((e) => e.type === 'telegraph')).toBe(true);
    expect(r.events.some((e) => e.type === 'technique' && e.fighter === 'opponent' && e.technique.id === 'jab' || e.type === 'technique' && e.fighter === 'opponent' && e.technique.id === 'rightCross')).toBe(true);
  });
  it('고정 샌드백: 맞고 밀려도 제자리로 복귀', () => {
    const w = new CombatWorld();
    const home = w.opponent.pos;
    runScript(w, w.player, [['Space', 0.2, 0.06], ['KeyQ', 0.29, 0.15], ['KeyI', 0.38, 0.08]], 6, 10);
    expect(Math.hypot(w.opponent.pos.x - home.x, w.opponent.pos.z - home.z)).toBeLessThan(0.1);
  });
});

describe('퍼즈 테스트 (예외/NaN 없음)', () => {
  it('무작위 키 입력 30초: 모든 관절 좌표 유한, HP 범위 유지', () => {
    const keys: ControlKey[] = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ControlLeft', 'Space', 'KeyU', 'KeyI', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'Semicolon', 'KeyM'];
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const w = new CombatWorld(11);
    w.setMode('sparring', 10);
    let now = 10;
    for (let i = 0; i < 30 * 120; i++) {
      if (rand() < 0.08) {
        const k = keys[Math.floor(rand() * keys.length)];
        if (w.player.input.isDown(k)) w.player.input.release(k, now);
        else w.player.input.press(k, now);
      }
      w.step(FIXED_DT, now);
      w.drainEvents();
      now += FIXED_DT;
      for (const f of [w.player, w.opponent]) {
        for (const j of JOINT_NAMES) {
          const p = f.pose[j];
          if (!Number.isFinite(p.x + p.y + p.z)) throw new Error(`NaN at ${f.name}.${j} step ${i}`);
        }
        expect(Number.isFinite(f.balance.comXZ.x)).toBe(true);
      }
      expect(w.opponent.hp).toBeGreaterThanOrEqual(0);
      expect(w.opponent.hp).toBeLessThanOrEqual(100);
    }
  });
});
