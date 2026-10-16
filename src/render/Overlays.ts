// 지지면(BoS) 폴리곤 · 무게중심(CoM) 마커 · 네온 트레일 리본 · 베지어 궤적 미리보기
import * as THREE from 'three';
import { bezierPoint } from '../animation/TrajectoryGenerator';
import type { FighterController, Strike } from '../combat/FighterController';
import { toWorld, yawBasis } from '../core/math';
import type { BalanceState, LimbId, TrajectoryShape } from '../types/combat';

const FLOOR_Y = 0.006;
const BOS_POINTS = 64;

export const SHAPE_COLOR: Record<TrajectoryShape, number> = {
  straight: 0x3fe0ff,
  horizontal: 0xff3fd2,
  verticalUp: 0x9dff3f,
  verticalDown: 0xff9a3f,
  overTop: 0xb07bff,
};

function ratioColor(r: number, out: THREE.Color): THREE.Color {
  if (r < 0.7) return out.setHex(0x3dff8a);
  if (r <= 1.0) return out.setHex(0xffd23f);
  return out.setHex(0xff3d3d);
}

export class BalanceView {
  readonly group = new THREE.Group();
  private readonly bosLine: THREE.LineLoop;
  private readonly bosFill: THREE.Mesh;
  private readonly comBall: THREE.Mesh;
  private readonly comDisc: THREE.Mesh;
  private readonly comLine: THREE.Line;
  private readonly centerDot: THREE.Mesh;
  private readonly color = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOS_POINTS * 3), 3));
    this.bosLine = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x3dff8a, transparent: true, opacity: 0.95 }));
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((BOS_POINTS + 1) * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < BOS_POINTS; i++) idx.push(BOS_POINTS, i, (i + 1) % BOS_POINTS);
    fillGeo.setIndex(idx);
    this.bosFill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x3dff8a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    this.comBall = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.comDisc = new THREE.Mesh(new THREE.RingGeometry(0.025, 0.045, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    this.comDisc.rotation.x = -Math.PI / 2;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.comLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.8 }));
    this.centerDot = new THREE.Mesh(new THREE.CircleGeometry(0.012, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    this.centerDot.rotation.x = -Math.PI / 2;
    this.group.add(this.bosFill, this.bosLine, this.comBall, this.comDisc, this.comLine, this.centerDot);
  }

  update(b: BalanceState): void {
    const pos = this.bosLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const fill = this.bosFill.geometry.getAttribute('position') as THREE.BufferAttribute;
    const bos = b.bos;
    this.bosLine.visible = this.bosFill.visible = bos.kind !== 'none';
    if (bos.kind !== 'none') {
      const ax = bos.a.x, az = bos.a.z, bx = bos.b.x, bz = bos.b.z;
      const ang = Math.atan2(bz - az, bx - ax);
      const half = BOS_POINTS / 2;
      for (let i = 0; i < BOS_POINTS; i++) {
        // 캡슐 외곽: 앞쪽 반원(b 쪽) + 뒤쪽 반원(a 쪽)
        const first = i < half;
        const k = first ? i / (half - 1) : (i - half) / (half - 1);
        const th = ang - Math.PI / 2 + k * Math.PI + (first ? 0 : Math.PI);
        const cx = first ? bx : ax;
        const cz = first ? bz : az;
        pos.setXYZ(i, cx + Math.cos(th) * bos.radius, FLOOR_Y, cz + Math.sin(th) * bos.radius);
        fill.setXYZ(i, cx + Math.cos(th) * bos.radius, FLOOR_Y - 0.001, cz + Math.sin(th) * bos.radius);
      }
      fill.setXYZ(BOS_POINTS, (ax + bx) / 2, FLOOR_Y - 0.001, (az + bz) / 2);
      pos.needsUpdate = true;
      fill.needsUpdate = true;
      this.bosLine.geometry.computeBoundingSphere();
      this.bosFill.geometry.computeBoundingSphere();
    }
    const c = ratioColor(b.ratio, this.color);
    (this.bosLine.material as THREE.LineBasicMaterial).color.copy(c);
    (this.bosFill.material as THREE.MeshBasicMaterial).color.copy(c);
    (this.comDisc.material as THREE.MeshBasicMaterial).color.copy(c);
    this.comBall.position.set(b.com.x, b.com.y, b.com.z);
    this.comDisc.position.set(b.comXZ.x, FLOOR_Y + 0.002, b.comXZ.z);
    this.centerDot.position.set(b.center.x, FLOOR_Y + 0.001, b.center.z);
    const lp = this.comLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    lp.setXYZ(0, b.com.x, b.com.y, b.com.z);
    lp.setXYZ(1, b.comXZ.x, FLOOR_Y, b.comXZ.z);
    lp.needsUpdate = true;
    this.comLine.computeLineDistances();
    this.comLine.geometry.computeBoundingSphere();
  }
}

// ───────── 트레일 리본 ─────────
const TRAIL_SAMPLES = 32;
const TRAIL_LIFE = 0.32;

interface TrailSample {
  outer: THREE.Vector3;
  inner: THREE.Vector3;
  t: number;
}

class TrailRibbon {
  readonly mesh: THREE.Mesh;
  private samples: TrailSample[] = [];
  private color = new THREE.Color();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(TRAIL_SAMPLES * 2 * 3);
    this.colors = new Float32Array(TRAIL_SAMPLES * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.mesh.frustumCulled = false;
  }

  push(outer: THREE.Vector3, inner: THREE.Vector3, now: number, shape: TrajectoryShape): void {
    this.color.setHex(SHAPE_COLOR[shape]);
    this.samples.push({ outer: outer.clone(), inner: inner.clone(), t: now });
    if (this.samples.length > TRAIL_SAMPLES) this.samples.shift();
  }

  update(now: number): void {
    this.samples = this.samples.filter((s) => now - s.t < TRAIL_LIFE);
    const n = this.samples.length;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const s = this.samples[Math.min(i, n - 1)];
      const o = i * 6;
      if (!s) {
        this.positions.fill(0, o, o + 6);
        this.colors.fill(0, o, o + 6);
        continue;
      }
      const fade = i < n ? Math.max(0, 1 - (now - s.t) / TRAIL_LIFE) : 0;
      this.positions.set([s.outer.x, s.outer.y, s.outer.z, s.inner.x, s.inner.y, s.inner.z], o);
      const k = fade * fade;
      this.colors.set([this.color.r * k, this.color.g * k, this.color.b * k, this.color.r * k * 0.25, this.color.g * k * 0.25, this.color.b * k * 0.25], o);
    }
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 1;
  }
}

/** 파이터 1명의 사지 4개 트레일 + 활성 베지어 궤적 미리보기 */
export class StrikeOverlay {
  readonly group = new THREE.Group();
  private readonly trails = new Map<LimbId, TrailRibbon>();
  private readonly curveLines = new Map<LimbId, THREE.Line>();
  private readonly ctrlDots = new Map<LimbId, THREE.Points>();
  private readonly outer = new THREE.Vector3();
  private readonly inner = new THREE.Vector3();

  constructor() {
    for (const limb of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as LimbId[]) {
      const t = new TrailRibbon();
      this.trails.set(limb, t);
      this.group.add(t.mesh);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
      line.frustumCulled = false;
      this.curveLines.set(limb, line);
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
      const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0.7 }));
      pts.frustumCulled = false;
      this.ctrlDots.set(limb, pts);
      this.group.add(line, pts);
    }
  }

  update(f: FighterController, now: number, showCurves: boolean): void {
    for (const [limb, trail] of this.trails) {
      const s = f.strikes.get(limb);
      if (s && (s.phase !== 'retract' || s.phaseT < 0.06)) {
        const mid = limb === 'leftArm' ? f.pose.lElbow : limb === 'rightArm' ? f.pose.rElbow : limb === 'leftLeg' ? f.pose.lKnee : f.pose.rKnee;
        this.outer.set(s.tip.x, s.tip.y, s.tip.z);
        this.inner.set(mid.x, mid.y, mid.z).sub(this.outer).multiplyScalar(s.striker === 'elbow' || s.striker === 'knee' ? 0.6 : 0.35).add(this.outer);
        trail.push(this.outer, this.inner, now, s.shape);
      }
      trail.update(now);
      this.updateCurve(limb, f, s, showCurves);
    }
  }

  private updateCurve(limb: LimbId, f: FighterController, s: Strike | undefined, show: boolean): void {
    const line = this.curveLines.get(limb)!;
    const dots = this.ctrlDots.get(limb)!;
    const visible = show && !!s && s.phase !== 'retract';
    line.visible = dots.visible = visible;
    if (!visible || !s) return;
    const basis = yawBasis(s.frameYaw);
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i <= 24; i++) {
      const p = toWorld(f.pos, basis, bezierPoint(s.curve, i / 24));
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    const dp = dots.geometry.getAttribute('position') as THREE.BufferAttribute;
    s.curve.forEach((c, i) => {
      const p = toWorld(f.pos, basis, c);
      dp.setXYZ(i, p.x, p.y, p.z);
    });
    dp.needsUpdate = true;
    (line.material as THREE.LineBasicMaterial).color.setHex(SHAPE_COLOR[s.shape]);
  }
}
