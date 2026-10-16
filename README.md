# KINETIC ARTS

운동 사슬(Kinetic Chain) 기반 절차적 무술 격투 프로토타입 (Vite + TypeScript + Three.js).
정해진 공격 애니메이션 없이 `하체 지면 반발 + 코어 회전 + 사지 신전/궤적` 조합으로 기술이 발현된다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 단위 + 헤드리스 시뮬레이션 테스트
npm run build      # tsc --noEmit + vite build
```

Ctrl+W 는 브라우저가 탭을 닫을 수 있으므로, 상단 **전체화면 + 키 잠금** 버튼(Chrome/Edge 의 Keyboard Lock API)을 누른 뒤 플레이하는 것을 권장한다.
잠금이 없을 때는 페이지를 떠나기 전에 확인창이 뜬다.

## 조작 (KeyboardEvent.code 기준)

| 왼손 | 역할 | 오른손 | 역할 |
| --- | --- | --- | --- |
| W / S | 전진 / 후진 스텝 | U / I | 왼팔 / 오른팔 신전 |
| A / D | 좌 / 우 스텝 | J / K | 왼발 / 오른발 신전 |
| Q / E | 코어 좌회전 / 우회전 | O | 수직 궤적 |
| Shift | 무게중심 하강 | L | 수평 궤적 |
| Ctrl | 뒷발 중심 이동 | ; | 관절 접기 / 가드 |
| Space | 지면 반발 | M | 파지 / 클린치 |

하체 → 코어 → 사지를 30~180ms 간격으로 치면 Perfect Chain(×1.5).

## 모듈 구조

엔진 독립 코어 로직(`core`, `input`, `physics`, `animation`, `combat`, `ai`)은 Three.js 를 쓰지 않으며, `render` 와 `ui` 만 브라우저에 의존한다.

```
src/
  core/        math.ts (벡터·스프링), ik.ts (2-Bone 해석적 IK)
  types/       combat.ts
  input/       ErgonomicInputManager.ts (입력 버퍼·연쇄 판정), TechniqueClassifier.ts
  physics/     KineticChainEngine.ts (m_eff·I_impact·코어 스프링), BalanceSystem.ts (CoM·BoS·Stumble)
  animation/   ProceduralFighterRig.ts (몸통 FK·발 디딤·포즈), TrajectoryGenerator.ts (베지어·페인트)
  combat/      FighterController.ts, CombatSystem.ts (히트박스·데미지), CombatWorld.ts (헤드리스 월드)
  ai/          SparringPartnerAI.ts (샌드백 / 가드·패링 더미 / 스파링 AI — 가상 키 입력)
  render/      SceneRenderer.ts, FighterView.ts, Overlays.ts, Effects.ts
  ui/          CombatHUD.ts, TutorialController.ts
tests/         unit.test.ts, sim.test.ts
```
