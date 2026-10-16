import { describe, expect, it } from 'vitest';
import { bezierPoint, bezierTangent, blendCurves, buildTrajectory, CHAMBER_RATIO, ARM_REACH } from '../src/animation/TrajectoryGenerator';
import { solveTwoBoneIK } from '../src/core/ik';
import { distance, dot, length, sub, v3 } from '../src/core/math';
import { InputBuffer, classifyChain, evaluateChain } from '../src/input/ErgonomicInputManager';
import { ClassifierInput, classifyTechnique, matchesDoubleLeg } from '../src/input/TechniqueClassifier';
import { computeBoS, stabilityRatio, BalanceMonitor } from '../src/physics/BalanceSystem';
import { computeImpact, effectiveMass } from '../src/physics/KineticChainEngine';
import type { BezierCurve, ControlKey, TrajectoryFlags } from '../src/types/combat';

// ───────── 3.1 연쇄 판정 ─────────
describe('classifyChain (η_chain)', () => {
  it('Perfect: 두 Δt 모두 [0.03, 0.18]', () => {
    expect(classifyChain(0.1, 0.1)).toEqual({ grade: 'perfect', eta: 1.5 });
  });
  it('경곗값 0.03 / 0.18 은 Perfect 에 포함', () => {
    expect(classifyChain(0.03, 0.18).eta).toBe(1.5);
    expect(classifyChain(0.18, 0.03).eta).toBe(1.5);
  });
  it('0.18 초과는 Isolated', () => {
    expect(classifyChain(0.181, 0.1).eta).toBe(1.0);
  });
  it('Simultaneous: 두 Δt 모두 < 0.03', () => {
    expect(classifyChain(0, 0.029)).toEqual({ grade: 'simultaneous', eta: 1.2 });
  });
  it('하나만 동시, 하나는 스윗스팟 → Isolated (명세 otherwise)', () => {
    expect(classifyChain(0.01, 0.1).eta).toBe(1.0);
    expect(classifyChain(0.1, 0.01).eta).toBe(1.0);
  });
  it('Δt 정의 불가(null) → Isolated', () => {
    expect(classifyChain(null, 0.1).eta).toBe(1.0);
  });
});

describe('InputBuffer / evaluateChain', () => {
  it('Space → Q → I 를 90ms 간격으로 → Perfect 1.5', () => {
    const b = new InputBuffer();
    b.press('Space', 10.0);
    b.press('KeyQ', 10.09);
    b.press('KeyI', 10.18);
    const c = evaluateChain(b, 10.18);
    expect(c.grade).toBe('perfect');
    expect(c.dt1).toBeCloseTo(0.09);
    expect(c.dt2).toBeCloseTo(0.09);
  });
  it('세 키 동시 (10ms 이내) → Simultaneous 1.2', () => {
    const b = new InputBuffer();
    b.press('KeyW', 10.0);
    b.press('KeyQ', 10.005);
    b.press('KeyI', 10.01);
    expect(evaluateChain(b, 10.01).eta).toBe(1.2);
  });
  it('하체 입력 없이 Q → I → Isolated 1.0 (사용자 확정 사항)', () => {
    const b = new InputBuffer();
    b.press('KeyQ', 10.0);
    b.press('KeyI', 10.1);
    const c = evaluateChain(b, 10.1);
    expect(c.eta).toBe(1.0);
    expect(c.dt1).toBeNull();
    expect(c.dt2).toBeCloseTo(0.1);
  });
  it('코어 입력 없이 사지만 → Isolated', () => {
    const b = new InputBuffer();
    b.press('KeyW', 10.0);
    b.press('KeyU', 10.1);
    expect(evaluateChain(b, 10.1).grade).toBe('isolated');
  });
  it('순서가 뒤집힌 입력 (코어 → 하체 → 사지): 코어 이전 하체 입력이 없으므로 Isolated', () => {
    const b = new InputBuffer();
    b.press('KeyQ', 10.0);
    b.press('Space', 10.05);
    b.press('KeyI', 10.1);
    expect(evaluateChain(b, 10.1).grade).toBe('isolated');
  });
  it('키 반복(이미 눌린 키) 은 무시되어 타임스탬프가 갱신되지 않는다', () => {
    const b = new InputBuffer();
    expect(b.press('KeyQ', 1)).toBe(true);
    expect(b.press('KeyQ', 2)).toBe(false);
    expect(b.lastPress('KeyQ')).toBe(1);
  });
  it('releaseAll 은 눌린 키를 모두 해제 (포커스 이탈 대비)', () => {
    const b = new InputBuffer();
    b.press('KeyW', 1);
    b.press('ShiftLeft', 1);
    b.releaseAll(2);
    expect(b.isDown('KeyW')).toBe(false);
    expect(b.isDown('ShiftLeft')).toBe(false);
  });
  it('drain 은 시간순 정렬', () => {
    const b = new InputBuffer();
    b.press('KeyI', 2);
    b.press('KeyQ', 1);
    expect(b.drain().map((e) => e.code)).toEqual(['KeyQ', 'KeyI']);
  });
});

// ───────── 3.2 유효 질량 / 충격량 ─────────
describe('effectiveMass / computeImpact', () => {
  it('기본 1.0', () => {
    expect(effectiveMass({ groundPush: false, coreDir: 0, limbSide: 'left' }).mEff).toBe(1.0);
  });
  it('Space ×1.4, Q + 오른손 ×1.3 → 1.82', () => {
    expect(effectiveMass({ groundPush: true, coreDir: 1, limbSide: 'right' }).mEff).toBeCloseTo(1.82);
  });
  it('E + 왼손 = 일치 ×1.3', () => {
    expect(effectiveMass({ groundPush: false, coreDir: -1, limbSide: 'left' }).mEff).toBeCloseTo(1.3);
  });
  it('역회전 ×0.6 (Q + 왼손)', () => {
    expect(effectiveMass({ groundPush: false, coreDir: 1, limbSide: 'left' }).mEff).toBeCloseTo(0.6);
  });
  it('I = η·m·|v_step + ω×r + v_limb|', () => {
    const r = computeImpact({ eta: 1.5, mEff: 1.3, vStep: v3(0, 0, 1), omegaCore: 10, rJoint: v3(-0.2, 0, 0), vLimb: v3(0, 0, 3) });
    // ω=(0,10,0) × r=(-0.2,0,0) = (0,0,2)
    expect(r.vRot.z).toBeCloseTo(2);
    expect(r.impulse).toBeCloseTo(1.5 * 1.3 * 6);
  });
});

// ───────── 3.3 베지어 ─────────
const flags = (p: Partial<TrajectoryFlags> = {}): TrajectoryFlags => ({ horizontal: false, vertical: false, chamber: false, overTop: false, ...p });

describe('TrajectoryGenerator', () => {
  const origin = v3(-0.19, 1.45, 0);
  const aim = v3(0, 1.6, 0.6);
  it('P(0)=P0, P(1)=P3', () => {
    const c = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags() });
    expect(distance(bezierPoint(c, 0), c[0])).toBeLessThan(1e-9);
    expect(distance(bezierPoint(c, 1), c[3])).toBeLessThan(1e-9);
  });
  it('직선: P1, P2 가 P0→P3 직선 위', () => {
    const c = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags() });
    const d = sub(c[3], c[0]);
    for (const p of [c[1], c[2]]) {
      const w = sub(p, c[0]);
      const crossLen = length(v3(w.y * d.z - w.z * d.y, w.z * d.x - w.x * d.z, w.x * d.y - w.y * d.x));
      expect(crossLen).toBeLessThan(1e-9);
    }
  });
  it('도달 거리는 ARM_REACH 로 제한', () => {
    const c = buildTrajectory({ limb: 'leftArm', origin, aim: v3(0, 1.5, 5), flags: flags() });
    expect(distance(c[0], c[3])).toBeCloseTo(ARM_REACH);
  });
  it('; 접기 → 도달 거리 45%', () => {
    const far = v3(0, 1.45, 5);
    const c = buildTrajectory({ limb: 'rightArm', origin, aim: far, flags: flags({ chamber: true }) });
    // 팔꿈치화 오프셋(안쪽 0.2) 을 제외한 전방 성분이 45%
    expect(c[3].z - c[0].z).toBeCloseTo(ARM_REACH * CHAMBER_RATIO, 2);
  });
  it('수평(L): 왼팔 제어점이 바깥(-x)으로', () => {
    const c = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags({ horizontal: true }) });
    const base = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags() });
    expect(c[1].x).toBeLessThan(base[1].x - 0.1);
    expect(c[2].x).toBeLessThan(base[2].x - 0.1);
  });
  it('수평(L): 오른다리 제어점이 바깥(+x)으로', () => {
    const o = v3(0.1, 0.92, 0);
    const a = v3(0, 1.1, 0.9);
    const c = buildTrajectory({ limb: 'rightLeg', origin: o, aim: a, flags: flags({ horizontal: true }) });
    expect(c[1].x).toBeGreaterThan(0.3);
  });
  it('수직(O) 팔: 아래에서 위 (어퍼컷)', () => {
    const c = buildTrajectory({ limb: 'rightArm', origin, aim, flags: flags({ vertical: true }) });
    const base = buildTrajectory({ limb: 'rightArm', origin, aim, flags: flags() });
    expect(c[1].y).toBeLessThan(base[1].y - 0.1);
  });
  it('수직(O) 다리: 위에서 아래 (내려찍기)', () => {
    const o = v3(0.1, 0.92, 0);
    const c = buildTrajectory({ limb: 'rightLeg', origin: o, aim: v3(0, 1.6, 0.9), flags: flags({ vertical: true }) });
    expect(c[1].y).toBeGreaterThan(c[3].y);
  });
  it('blendCurves: t=0 은 원래, t=1 은 목표, P0 유지', () => {
    const a = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags() });
    const b = buildTrajectory({ limb: 'leftArm', origin, aim, flags: flags({ horizontal: true }) });
    const m0 = blendCurves(a, b, 0);
    const m1 = blendCurves(a, b, 1);
    expect(distance(m0[1], a[1])).toBeLessThan(1e-9);
    expect(distance(m1[2], b[2])).toBeLessThan(1e-9);
    expect(m1[0]).toBe(a[0]);
  });
  it('tangent 는 수치 미분과 일치', () => {
    const c: BezierCurve = [v3(0, 0, 0), v3(1, 2, 0), v3(2, -1, 1), v3(3, 0, 2)];
    const u = 0.37;
    const h = 1e-5;
    const num = sub(bezierPoint(c, u + h), bezierPoint(c, u - h));
    const an = bezierTangent(c, u);
    expect(an.x).toBeCloseTo(num.x / (2 * h), 4);
    expect(an.y).toBeCloseTo(num.y / (2 * h), 4);
  });
});

// ───────── 2-Bone IK ─────────
describe('solveTwoBoneIK', () => {
  it('도달 가능한 타겟: 뼈 길이 보존 + 끝단 일치', () => {
    const root = v3(0, 1.4, 0);
    const target = v3(0.1, 1.3, 0.4);
    const r = solveTwoBoneIK(root, target, 0.3, 0.28, v3(0, -1, 0));
    expect(distance(root, r.mid)).toBeCloseTo(0.3, 6);
    expect(distance(r.mid, r.end)).toBeCloseTo(0.28, 6);
    expect(distance(r.end, target)).toBeLessThan(1e-6);
  });
  it('도달 불가: 최대 신전으로 클램프, NaN 없음', () => {
    const r = solveTwoBoneIK(v3(), v3(0, 0, 5), 0.3, 0.28, v3(0, -1, 0));
    expect(length(r.end)).toBeCloseTo(0.58, 3);
    expect(Number.isFinite(r.mid.x + r.mid.y + r.mid.z)).toBe(true);
  });
  it('타겟이 루트와 동일 / 폴이 축과 평행해도 NaN 없음', () => {
    const r1 = solveTwoBoneIK(v3(), v3(), 0.3, 0.28, v3(0, -1, 0));
    const r2 = solveTwoBoneIK(v3(), v3(0, 0, 0.4), 0.3, 0.28, v3(0, 0, 1));
    for (const p of [r1.mid, r1.end, r2.mid, r2.end]) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });
  it('중간 관절은 폴 방향으로 굽는다', () => {
    const r = solveTwoBoneIK(v3(), v3(0, 0, 0.4), 0.3, 0.28, v3(0, -1, 0));
    expect(dot(r.mid, v3(0, -1, 0))).toBeGreaterThan(0.1);
  });
});

// ───────── 3.4 밸런스 ─────────
describe('BalanceSystem', () => {
  it('양발 캡슐 내부 → ratio < 1', () => {
    const bos = computeBoS([v3(-0.13, 0, 0.2), v3(0.13, 0, -0.2)]);
    expect(bos.kind).toBe('capsule');
    expect(stabilityRatio(v3(0, 0, 0), bos).ratio).toBeLessThan(1);
  });
  it('캡슐 바깥 → ratio > 1', () => {
    const bos = computeBoS([v3(-0.13, 0, 0.2), v3(0.13, 0, -0.2)]);
    expect(stabilityRatio(v3(0.4, 0, 0.3), bos).ratio).toBeGreaterThan(1);
  });
  it('한 발 → 축소된 원', () => {
    const bos = computeBoS([v3(0, 0, 0)]);
    expect(bos.kind).toBe('circle');
    expect(stabilityRatio(v3(0.2, 0, 0), bos).ratio).toBeGreaterThan(1);
    expect(stabilityRatio(v3(0.05, 0, 0), bos).ratio).toBeLessThan(1);
  });
  it('지지 발 없음 → Infinity', () => {
    expect(stabilityRatio(v3(), computeBoS([])).ratio).toBe(Infinity);
  });
  it('ratio > 1 에서 무리한 동작 지속 → Stumble 발생, 안정 상태에선 발생하지 않음', () => {
    const m = new BalanceMonitor();
    let fired = false;
    for (let i = 0; i < 120 && !fired; i++) fired = m.update(0.8, true, 1 / 120);
    expect(fired).toBe(false);
    for (let i = 0; i < 120 && !fired; i++) fired = m.update(1.5, true, 1 / 120);
    expect(fired).toBe(true);
  });
  it('ratio > 1 이어도 가만히 있으면 Stumble 없음', () => {
    const m = new BalanceMonitor();
    let fired = false;
    for (let i = 0; i < 240; i++) fired = fired || m.update(1.5, false, 1 / 120);
    expect(fired).toBe(false);
  });
});

// ───────── 4. 기술 판정표 ─────────
const K = (...k: ControlKey[]) => new Set<ControlKey>(k);
function ci(p: Partial<ClassifierInput> & { keys: Set<ControlKey> }): ClassifierInput {
  const has = (c: ControlKey) => p.keys.has(c);
  return {
    action: 'strike',
    limb: null,
    rotationDeg: 0,
    flags: flags({ horizontal: has('KeyL'), vertical: has('KeyO'), chamber: has('Semicolon') }),
    clinched: false,
    feintWindowKeys: new Set(),
    ...p,
  };
}
const id = (p: Partial<ClassifierInput> & { keys: Set<ControlKey> }) => classifyTechnique(ci(p)).id;

describe('TechniqueClassifier (14개 판정표)', () => {
  it('1. 잽: U 단독 / W+U', () => {
    expect(id({ limb: 'leftArm', keys: K('KeyU') })).toBe('jab');
    expect(id({ limb: 'leftArm', keys: K('KeyW', 'KeyU') })).toBe('jab');
    expect(id({ limb: 'leftArm', keys: K('KeyS', 'KeyU') })).toBe('freeform');
  });
  it('2. 라이트 크로스: (Space)+Q+I', () => {
    expect(id({ limb: 'rightArm', keys: K('KeyQ', 'KeyI') })).toBe('rightCross');
    expect(id({ limb: 'rightArm', keys: K('Space', 'KeyQ', 'KeyI') })).toBe('rightCross');
  });
  it('3. 레프트 훅: E+L+U', () => {
    expect(id({ limb: 'leftArm', keys: K('KeyE', 'KeyL', 'KeyU') })).toBe('leftHook');
  });
  it('4. 리버 블로우: Shift+E+L+U', () => {
    expect(id({ limb: 'leftArm', keys: K('ShiftLeft', 'KeyE', 'KeyL', 'KeyU') })).toBe('leftLiverHook');
  });
  it('5. 라이트 어퍼컷: Shift+Q+O+I', () => {
    expect(id({ limb: 'rightArm', keys: K('ShiftLeft', 'KeyQ', 'KeyO', 'KeyI') })).toBe('rightUppercut');
  });
  it('6. 스피닝 백피스트: E(>120°)+L+U, 120° 이하는 훅', () => {
    expect(id({ limb: 'leftArm', rotationDeg: -150, keys: K('KeyE', 'KeyL', 'KeyU') })).toBe('spinningBackfist');
    expect(id({ limb: 'leftArm', rotationDeg: -100, keys: K('KeyE', 'KeyL', 'KeyU') })).toBe('leftHook');
  });
  it('7. 수평 엘보우: Q/E+;+L+U/I', () => {
    expect(id({ limb: 'rightArm', keys: K('KeyQ', 'Semicolon', 'KeyL', 'KeyI') })).toBe('horizontalElbow');
    expect(id({ limb: 'leftArm', keys: K('KeyE', 'Semicolon', 'KeyL', 'KeyU') })).toBe('horizontalElbow');
  });
  it('8. 앞차기/팁: Ctrl+J 또는 K', () => {
    expect(id({ limb: 'leftLeg', keys: K('ControlLeft', 'KeyJ') })).toBe('teep');
    expect(id({ limb: 'rightLeg', keys: K('ControlLeft', 'KeyK') })).toBe('teep');
  });
  it('9. 돌려차기: Space+Q+L+K', () => {
    expect(id({ limb: 'rightLeg', keys: K('Space', 'KeyQ', 'KeyL', 'KeyK') })).toBe('roundhouse');
  });
  it('10. 브라질리언 킥: K 후 u∈[0.15,0.45] 에 Q+L', () => {
    expect(id({ limb: 'rightLeg', keys: K('KeyK', 'KeyQ', 'KeyL'), feintWindowKeys: K('KeyQ', 'KeyL') })).toBe('brazilianKick');
    expect(id({ limb: 'rightLeg', keys: K('KeyK', 'KeyQ', 'KeyL'), feintWindowKeys: K('KeyL') })).not.toBe('brazilianKick');
  });
  it('11. 클린치 니킥: 파지 성공 + ; + O + K/J', () => {
    expect(id({ limb: 'rightLeg', clinched: true, keys: K('KeyM', 'Semicolon', 'KeyO', 'KeyK') })).toBe('clinchKnee');
    expect(id({ limb: 'rightLeg', clinched: false, keys: K('KeyM', 'Semicolon', 'KeyO', 'KeyK') })).not.toBe('clinchKnee');
  });
  it('12. 뒤차기: Q(>135°)+Space+K', () => {
    expect(id({ limb: 'rightLeg', rotationDeg: 170, keys: K('KeyQ', 'Space', 'KeyK') })).toBe('spinningBackKick');
    expect(id({ limb: 'rightLeg', rotationDeg: 120, keys: K('KeyQ', 'Space', 'KeyK') })).not.toBe('spinningBackKick');
  });
  it('13. 더블 렉: Shift+Space+W+U+I+M', () => {
    expect(matchesDoubleLeg(K('ShiftLeft', 'Space', 'KeyW', 'KeyU', 'KeyI', 'KeyM'))).toBe(true);
    expect(matchesDoubleLeg(K('ShiftLeft', 'Space', 'KeyW', 'KeyU', 'KeyI'))).toBe(false);
    expect(id({ action: 'takedown', limb: null, keys: K() })).toBe('doubleLegTakedown');
  });
  it('14. 가드 / 패링', () => {
    expect(id({ action: 'guard', limb: null, keys: K('Semicolon') })).toBe('guard');
    expect(id({ action: 'parry', limb: null, keys: K('Semicolon', 'KeyU') })).toBe('parry');
  });
  it('판정표에 없는 조합은 freeform 서술명', () => {
    const r = classifyTechnique(ci({ limb: 'rightLeg', keys: K('ShiftLeft', 'KeyK') }));
    expect(r.id).toBe('freeform');
    expect(r.name).toContain('Low');
  });
});
