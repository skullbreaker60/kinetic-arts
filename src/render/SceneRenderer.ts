// Three.js 렌더링 계층 — 시뮬레이션(CombatWorld) 상태를 읽기만 한다
import * as THREE from 'three';
import type { CombatWorld } from '../combat/CombatWorld';
import { clamp, wrapAngle, yawTowards } from '../core/math';
import type { WorldEvent } from '../types/combat';
import { Effects } from './Effects';
import { FighterView } from './FighterView';
import { BalanceView, StrikeOverlay } from './Overlays';

export interface RenderOptions {
  showBalance: boolean;
  showCurves: boolean;
}

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 격투 축에 수직인 측면 카메라. 드래그 = 방위/고도 오프셋, 휠 = 거리 */
  private readonly rig = { axisYaw: 0, azOffset: -0.3, polar: 1.3, radius: 5.0 };
  private drag: { x: number; y: number } | null = null;
  private readonly views: FighterView[];
  private readonly balance: BalanceView[];
  private readonly strikes: StrikeOverlay[];
  private readonly effects = new Effects();
  private shake = 0;
  private readonly lastTarget = new THREE.Vector3();
  readonly options: RenderOptions = { showBalance: true, showCurves: true };

  constructor(private readonly container: HTMLElement, private readonly world: CombatWorld) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0d0f14);
    this.scene.fog = new THREE.Fog(0x0d0f14, 7, 16);

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.05, 60);
    this.lastTarget.set(0, 0.95, 0);
    this.rig.axisYaw = yawTowards(world.player.pos, world.opponent.pos);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.rig.azOffset -= (e.clientX - this.drag.x) * 0.006;
      this.rig.polar = clamp(this.rig.polar - (e.clientY - this.drag.y) * 0.004, 0.45, 1.52);
      this.drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => (this.drag = null));
    canvas.addEventListener('wheel', (e) => {
      this.rig.radius = clamp(this.rig.radius * Math.exp(e.deltaY * 0.001), 2, 10);
      e.preventDefault();
    }, { passive: false });

    this.buildDojo();

    this.views = [new FighterView(world.player.color), new FighterView(world.opponent.color)];
    this.balance = [new BalanceView(), new BalanceView()];
    this.strikes = [new StrikeOverlay(), new StrikeOverlay()];
    for (const v of this.views) this.scene.add(v.group);
    for (const b of this.balance) this.scene.add(b.group);
    for (const s of this.strikes) this.scene.add(s.group);
    this.scene.add(this.effects.group);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private buildDojo(): void {
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2a1e14, 0.75);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(-3, 6, -2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.9);
    rim.position.set(4, 3, 5);
    this.scene.add(rim);

    // 나무 바닥 + 매트
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 9.6), new THREE.MeshStandardMaterial({ color: 0x1f3a32, roughness: 0.95 }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.002;
    mat.receiveShadow = true;
    this.scene.add(mat);
    const grid = new THREE.GridHelper(9.6, 24, 0x5f8f7f, 0x2f5247);
    grid.position.y = 0.004;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(grid);
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.45, 4.5, 96), new THREE.MeshBasicMaterial({ color: 0xc9a227, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    this.scene.add(ring);
    // 도장 기둥
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4a1f17, roughness: 0.6 });
    for (const [x, z] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4, 16), pillarMat);
      p.position.set(x, 2, z);
      p.castShadow = true;
      this.scene.add(p);
    }
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  handleEvents(events: WorldEvent[], now: number): void {
    for (const e of events) {
      if (e.type === 'hit') {
        const color = e.attacker === 'player' ? 0xffd23f : 0xff5a3d;
        this.effects.hit(e.point, e.impulse, color, e.blocked);
        this.shake = Math.max(this.shake, Math.min(0.012 + e.impulse * 0.0035, 0.11) * (e.blocked ? 0.4 : 1));
      } else if (e.type === 'parry') {
        this.effects.parry(e.point);
        this.shake = Math.max(this.shake, 0.02);
      } else if (e.type === 'takedown' && e.success) {
        this.shake = Math.max(this.shake, 0.06);
      } else if (e.type === 'telegraph') {
        this.effects.showTelegraph(now);
      }
    }
  }

  render(now: number, dt: number): void {
    const fighters = [this.world.player, this.world.opponent];
    fighters.forEach((f, i) => {
      this.views[i].update(f, now);
      this.balance[i].group.visible = this.options.showBalance;
      if (this.options.showBalance) this.balance[i].update(f.balance);
      this.strikes[i].update(f, now, this.options.showCurves);
    });
    this.effects.update(dt, now, this.camera, this.world.opponent.pose.head);

    // 카메라: 두 파이터 중점을 추적하며 격투 축에 수직(플레이어 왼쪽 화면) 시점을 유지
    const p = this.world.player.pos;
    const o = this.world.opponent.pos;
    const mid = new THREE.Vector3((p.x + o.x) / 2, 0.95, (p.z + o.z) / 2);
    this.lastTarget.lerp(mid, 1 - Math.exp(-4 * dt));
    const axis = yawTowards(p, o);
    this.rig.axisYaw = wrapAngle(this.rig.axisYaw + wrapAngle(axis - this.rig.axisYaw) * (1 - Math.exp(-4.5 * dt)));
    // 플레이어의 오른쪽(-cos, sin) 방향에서 바라보면 플레이어가 화면 왼쪽, 상대가 오른쪽
    const az = this.rig.axisYaw + this.rig.azOffset;
    const dir = new THREE.Vector3(-Math.cos(az), 0, Math.sin(az));
    const sp = Math.sin(this.rig.polar);
    this.camera.position.set(
      this.lastTarget.x + dir.x * sp * this.rig.radius,
      this.lastTarget.y + Math.cos(this.rig.polar) * this.rig.radius,
      this.lastTarget.z + dir.z * sp * this.rig.radius,
    );
    this.camera.lookAt(this.lastTarget);

    // 카메라 쉐이크
    const shakeOffset = new THREE.Vector3();
    if (this.shake > 1e-4) {
      shakeOffset.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).multiplyScalar(this.shake);
      this.shake *= Math.exp(-12 * dt);
    }
    this.camera.position.add(shakeOffset);
    this.renderer.render(this.scene, this.camera);
    this.camera.position.sub(shakeOffset);
  }
}
