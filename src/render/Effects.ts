// 타격 이펙트: 충격파 링 + 파티클 + 패링 스파크 + 공격 예고 마커
import * as THREE from 'three';
import type { Vec3 } from '../core/math';

const MAX_PARTICLES = 400;
const RING_POOL = 10;

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  size: number;
}

export class Effects {
  readonly group = new THREE.Group();
  private readonly rings: Ring[] = [];
  private readonly points: THREE.Points;
  private readonly pPos = new Float32Array(MAX_PARTICLES * 3);
  private readonly pCol = new Float32Array(MAX_PARTICLES * 3);
  private readonly pVel = new Float32Array(MAX_PARTICLES * 3);
  private readonly pLife = new Float32Array(MAX_PARTICLES);
  private readonly pBase = new Float32Array(MAX_PARTICLES * 3);
  private cursor = 0;
  private readonly telegraph: THREE.Mesh;
  private telegraphT = -1;

  constructor() {
    const ringGeo = new THREE.RingGeometry(0.8, 1.0, 40);
    for (let i = 0; i < RING_POOL; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, t: 0, life: 0, size: 0 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.04, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this.telegraph = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), new THREE.MeshBasicMaterial({ color: 0xff3d3d, transparent: true, opacity: 0 }));
    this.telegraph.rotation.x = Math.PI;
    this.group.add(this.telegraph);
  }

  /** 충격량에 비례한 충격파 + 파티클 */
  hit(p: Vec3, impulse: number, color: number, blocked: boolean): void {
    const size = 0.12 + Math.min(impulse, 30) * 0.022;
    this.spawnRing(p, size, blocked ? 0x8fb8ff : color, 0.32);
    if (impulse > 12) this.spawnRing(p, size * 1.6, 0xffffff, 0.45);
    const n = Math.min(80, 10 + Math.round(impulse * 3));
    this.spawnParticles(p, n, 1.2 + impulse * 0.12, blocked ? 0x8fb8ff : color);
  }

  parry(p: Vec3): void {
    this.spawnRing(p, 0.35, 0x6fd8ff, 0.3);
    this.spawnParticles(p, 40, 2.5, 0x9fe8ff);
  }

  showTelegraph(now: number): void {
    this.telegraphT = now;
  }

  private spawnRing(p: Vec3, size: number, color: number, life: number): void {
    const r = this.rings.find((x) => !x.mesh.visible) ?? this.rings[0];
    r.mesh.visible = true;
    r.mesh.position.set(p.x, p.y, p.z);
    (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.t = 0;
    r.life = life;
    r.size = size;
  }

  private spawnParticles(p: Vec3, n: number, speed: number, color: number): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.pPos.set([p.x, p.y, p.z], k * 3);
      this.pVel.set([s * Math.cos(th) * sp, u * sp + 0.8, s * Math.sin(th) * sp], k * 3);
      this.pBase.set([c.r, c.g, c.b], k * 3);
      this.pLife[k] = 0.35 + Math.random() * 0.35;
    }
  }

  update(dt: number, now: number, camera: THREE.Camera, telegraphAt: Vec3 | null): void {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.mesh.scale.setScalar(r.size * (0.3 + k * 1.2));
      r.mesh.lookAt(camera.position);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    }
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) {
        this.pCol[i * 3] = this.pCol[i * 3 + 1] = this.pCol[i * 3 + 2] = 0;
        continue;
      }
      this.pLife[i] -= dt;
      this.pVel[i * 3 + 1] -= 6 * dt;
      for (let a = 0; a < 3; a++) this.pPos[i * 3 + a] += this.pVel[i * 3 + a] * dt;
      const f = Math.max(0, Math.min(1, this.pLife[i] * 2.5));
      for (let a = 0; a < 3; a++) this.pCol[i * 3 + a] = this.pBase[i * 3 + a] * f;
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    const tk = now - this.telegraphT;
    const mat = this.telegraph.material as THREE.MeshBasicMaterial;
    if (telegraphAt && this.telegraphT > 0 && tk < 0.55) {
      this.telegraph.position.set(telegraphAt.x, telegraphAt.y + 0.28 + Math.sin(tk * 30) * 0.02, telegraphAt.z);
      mat.opacity = 0.9;
    } else {
      mat.opacity = 0;
    }
  }
}
