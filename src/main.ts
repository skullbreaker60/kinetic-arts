// 엔트리 포인트: 120Hz 고정 물리 스텝 + 가변 렌더 프레임
import { CombatWorld, FIXED_DT } from './combat/CombatWorld';
import { ErgonomicInputManager } from './input/ErgonomicInputManager';
import { SceneRenderer } from './render/SceneRenderer';
import './style.css';
import { CombatHUD } from './ui/CombatHUD';
import { TutorialController } from './ui/TutorialController';

const MAX_STEPS_PER_FRAME = 12;
const clock = () => performance.now() / 1000;

const app = document.getElementById('app')!;
const viewport = document.createElement('div');
viewport.className = 'viewport';
app.appendChild(viewport);

const input = new ErgonomicInputManager(window);
const world = new CombatWorld(Date.now() % 100000, input);
const renderer = new SceneRenderer(viewport, world);
const tutorial = new TutorialController(world, input);
const hud = new CombatHUD(app, world, input, tutorial, renderer.options, clock);

let last = clock();
let acc = 0;

function frame(): void {
  const now = clock();
  const dt = Math.min(now - last, 0.1);
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
    // 스텝 시각: 입력 타임스탬프(KeyboardEvent.timeStamp)와 같은 performance.now 기준
    const stepNow = now - acc + FIXED_DT;
    tutorial.update(stepNow);
    world.step(FIXED_DT, stepNow);
    acc -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0; // 탭 복귀 등으로 밀린 시간은 버린다

  const events = world.drainEvents();
  renderer.handleEvents(events, now);
  hud.handleEvents(events, now);
  tutorial.onEvents(events, now);

  renderer.render(now, dt);
  hud.update(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
