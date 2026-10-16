// 3D 관절 마네킹 렌더링 + 운동 사슬 에너지 발광 (FighterController 의 포즈를 그대로 그린다)
import * as THREE from 'three';
import type { FighterController } from '../combat/FighterController';
import type { Vec3 } from '../core/math';
import type { ChainGrade, JointName, LimbId } from '../types/combat';
import { JOINT_NAMES } from '../types/combat';

type SegGroup = 'core' | LimbId;

export const GRADE_COLOR: Record<ChainGrade, number> = {
  perfect: 0xffd23f,
  simultaneous: 0x3fe0ff,
  isolated: 0xffffff,
};
const GROUND_COLOR = new THREE.Color(0x4dff9a);
const CORE_COLOR = new THREE.Color(0xffa63f);
const HIT_COLOR = new THREE.Color(0xff2a2a);

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

export const toV3 = (v: Vec3, out = new THREE.Vector3()) => out.set(v.x, v.y, v.z);

interface Bone {
  a: JointName;
  b: JointName;
  mesh: THREE.Mesh;
}

export class FighterView {
  readonly group = new THREE.Group();
  private readonly mats = new Map<SegGroup, THREE.MeshStandardMaterial>();
  private readonly jointMeshes = new Map<JointName, THREE.Mesh>();
  private readonly bones: Bone[] = [];
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly nose: THREE.Mesh;
  private readonly fists: THREE.Mesh[] = [];
  private readonly feet: THREE.Mesh[] = [];
  private readonly baseColor: THREE.Color;

  constructor(color: number) {
    this.baseColor = new THREE.Color(color);
    const mk = (g: SegGroup, c: THREE.Color) => {
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.15, emissive: 0x000000 });
      this.mats.set(g, m);
      return m;
    };
    const limbColor = this.baseColor.clone();
    const coreColor = this.baseColor.clone().multiplyScalar(0.75);
    mk('core', coreColor);
    mk('leftArm', limbColor);
    mk('rightArm', limbColor.clone().offsetHSL(0, 0, -0.08));
    mk('leftLeg', limbColor.clone().offsetHSL(0, 0, -0.04));
    mk('rightLeg', limbColor.clone().offsetHSL(0, 0, -0.12));

    const jointMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3, metalness: 0.4 });
    const jointGeo = new THREE.SphereGeometry(1, 14, 10);
    for (const j of JOINT_NAMES) {
      if (j === 'head') continue;
      const r = j === 'pelvis' ? 0.055 : j === 'thorax' || j === 'lumbar' ? 0.045 : 0.036;
      const m = new THREE.Mesh(jointGeo, jointMat);
      m.scale.setScalar(r);
      m.castShadow = true;
      this.group.add(m);
      this.jointMeshes.set(j, m);
    }

    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
    const bone = (a: JointName, b: JointName, g: SegGroup, r: number) => {
      const mesh = new THREE.Mesh(boneGeo, this.mats.get(g)!);
      mesh.scale.set(r, 1, r);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.bones.push({ a, b, mesh });
    };
    bone('pelvis', 'lumbar', 'core', 0.05);
    bone('lumbar', 'thorax', 'core', 0.05);
    bone('lShoulder', 'rShoulder', 'core', 0.04);
    bone('lHip', 'rHip', 'core', 0.045);
    bone('lShoulder', 'lElbow', 'leftArm', 0.04);
    bone('lElbow', 'lWrist', 'leftArm', 0.034);
    bone('rShoulder', 'rElbow', 'rightArm', 0.04);
    bone('rElbow', 'rWrist', 'rightArm', 0.034);
    bone('lHip', 'lKnee', 'leftLeg', 0.055);
    bone('lKnee', 'lAnkle', 'leftLeg', 0.045);
    bone('rHip', 'rKnee', 'rightLeg', 0.055);
    bone('rKnee', 'rAnkle', 'rightLeg', 0.045);

    // 몸통 볼륨 (반투명 캡슐) — 관절이 잘 보이도록
    const torsoMat = this.mats.get('core')!.clone();
    torsoMat.transparent = true;
    torsoMat.opacity = 0.55;
    this.mats.set('core', torsoMat);
    for (const b of this.bones) if (b.mesh.material === this.mats.get('core')) b.mesh.material = torsoMat;
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 1, 6, 14), torsoMat);
    this.torso.castShadow = true;
    this.group.add(this.torso);

    this.headMat = new THREE.MeshStandardMaterial({ color: coreColor, roughness: 0.5, metalness: 0.1 });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), this.headMat);
    this.head.castShadow = true;
    this.group.add(this.head);
    this.nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.05), jointMat);
    this.group.add(this.nose);

    const fistGeo = new THREE.SphereGeometry(0.048, 14, 10);
    this.fists.push(new THREE.Mesh(fistGeo, this.mats.get('leftArm')!), new THREE.Mesh(fistGeo, this.mats.get('rightArm')!));
    const footGeo = new THREE.BoxGeometry(0.09, 0.05, 0.24);
    this.feet.push(new THREE.Mesh(footGeo, this.mats.get('leftLeg')!), new THREE.Mesh(footGeo, this.mats.get('rightLeg')!));
    for (const m of [...this.fists, ...this.feet]) {
      m.castShadow = true;
      this.group.add(m);
    }
  }

  private placeBone(mesh: THREE.Object3D, a: Vec3, b: Vec3, extra = 0): void {
    toV3(a, tmpA);
    toV3(b, tmpB);
    tmpDir.subVectors(tmpB, tmpA);
    const len = tmpDir.length();
    mesh.position.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, tmpDir.divideScalar(len));
    mesh.scale.y = Math.max(len + extra, 1e-3);
  }

  update(f: FighterController, now: number): void {
    const p = f.pose;
    for (const [j, m] of this.jointMeshes) toV3(p[j], m.position);
    for (const b of this.bones) this.placeBone(b.mesh, p[b.a], p[b.b]);

    // 캡슐 몸통: CapsuleGeometry 길이 1 기준 → 스케일
    this.placeBone(this.torso, p.pelvis, p.thorax);
    const tl = this.torso.scale.y;
    this.torso.scale.set(1, Math.max(tl - 0.1, 0.05), 1);

    toV3(p.head, this.head.position);
    const t = f.torso;
    this.nose.position.set(p.head.x + t.chest.forward.x * 0.11, p.head.y + t.chest.forward.y * 0.11, p.head.z + t.chest.forward.z * 0.11);
    this.nose.rotation.set(0, f.heading + f.core.yaw, 0);

    for (const [i, side] of (['left', 'right'] as const).entries()) {
      const e = side === 'left' ? p.lElbow : p.rElbow;
      const w = side === 'left' ? p.lWrist : p.rWrist;
      tmpDir.set(w.x - e.x, w.y - e.y, w.z - e.z).normalize();
      this.fists[i].position.set(w.x + tmpDir.x * 0.04, w.y + tmpDir.y * 0.04, w.z + tmpDir.z * 0.04);
      const a = side === 'left' ? p.lAnkle : p.rAnkle;
      const k = side === 'left' ? p.lKnee : p.rKnee;
      const foot = this.feet[i];
      foot.position.set(a.x, Math.max(a.y - 0.04, 0.025), a.z);
      // 발은 정강이에 대략 수직, 진행 방향을 향함
      const kicking = f.strikes.has(side === 'left' ? 'leftLeg' : 'rightLeg');
      if (kicking) {
        tmpDir.set(a.x - k.x, a.y - k.y, a.z - k.z).normalize();
        foot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tmpDir);
      } else {
        foot.quaternion.setFromAxisAngle(UP, f.heading);
      }
    }

    // ── 운동 사슬 에너지 발광: 하체 → 코어 → 사지 ──
    const glow = (t0: number, rate: number) => Math.exp(-Math.max(0, now - t0) * rate);
    const hit = glow(f.hitFlash, 7);
    const gColor = new THREE.Color(GRADE_COLOR[f.energy.grade]);
    const setEm = (g: SegGroup, c: THREE.Color, k: number) => {
      const m = this.mats.get(g)!;
      m.emissive.copy(c).multiplyScalar(k);
      if (hit > 0.02) m.emissive.lerp(HIT_COLOR, hit);
    };
    this.headMat.emissive.copy(HIT_COLOR).multiplyScalar(hit);
    setEm('leftLeg', GROUND_COLOR, glow(f.energy.ground, 5) * 0.8);
    setEm('rightLeg', GROUND_COLOR, glow(f.energy.ground, 5) * 0.8);
    setEm('core', CORE_COLOR, glow(f.energy.core, 4.5) * 0.9);
    for (const limb of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as LimbId[]) {
      const s = f.strikes.get(limb);
      const active = s && s.phase !== 'retract' ? 0.5 : 0;
      const k = Math.max(glow(f.energy.limbs[limb], 3.5), active);
      if (k > 0.02) setEm(limb, gColor, k);
    }
    // 가드 시 팔 하이라이트
    if (f.guardUp) {
      this.mats.get('leftArm')!.emissive.setRGB(0.25, 0.35, 0.6);
      this.mats.get('rightArm')!.emissive.setRGB(0.25, 0.35, 0.6);
    }
  }
}
