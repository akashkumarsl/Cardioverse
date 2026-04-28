import * as THREE from "three";

function ventricularEnvelope(t) {
  if (t < 0.12)      return Math.sin((t / 0.12) * Math.PI * 0.5);
  if (t < 0.35)      return 1.0 - 0.6 * ((t - 0.12) / 0.23);
  if (t < 0.55) {
    const u = (t - 0.35) / 0.20;
    return 0.4 - 0.2 * Math.sin(u * Math.PI);
  }
  const u = (t - 0.55) / 0.45;
  return 0.4 * (1.0 - u) - 0.05 * Math.sin(u * Math.PI);
}

export class Heart {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.bpm = 70; this.cycleT = 0; this.envelope = 0;

    this.mat = new THREE.MeshStandardMaterial({
      color: 0x8a1f2c, roughness: 0.45, metalness: 0.05,
      emissive: new THREE.Color(0x551018), emissiveIntensity: 0.25
    });
    this.matAtria = this.mat.clone(); this.matAtria.color.setHex(0x6b1a25);
    this.matAorta = new THREE.MeshStandardMaterial({
      color: 0xd66060, roughness: 0.4, metalness: 0.1,
      emissive: 0x3a0e14, emissiveIntensity: 0.2
    });
    this.matVein = new THREE.MeshStandardMaterial({
      color: 0x35506b, roughness: 0.5, metalness: 0.1,
      emissive: 0x101822, emissiveIntensity: 0.2
    });

    this.lv = new THREE.Mesh(new THREE.SphereGeometry(0.62, 64, 48), this.mat);
    this.lv.position.set(-0.18, -0.1, 0); this.lv.scale.set(0.95, 1.25, 0.95);
    this.group.add(this.lv);

    this.rv = new THREE.Mesh(new THREE.SphereGeometry(0.55, 64, 48), this.mat);
    this.rv.position.set(0.30, -0.05, 0.05); this.rv.scale.set(0.95, 1.15, 0.9);
    this.group.add(this.rv);

    this.apex = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.95, 48), this.mat);
    this.apex.position.set(-0.05, -0.92, 0); this.apex.rotation.x = Math.PI;
    this.group.add(this.apex);

    this.la = new THREE.Mesh(new THREE.SphereGeometry(0.30, 32, 24), this.matAtria);
    this.la.position.set(-0.30, 0.55, -0.05); this.la.scale.set(0.9, 0.7, 0.9);
    this.group.add(this.la);
    this.ra = new THREE.Mesh(new THREE.SphereGeometry(0.32, 32, 24), this.matAtria);
    this.ra.position.set(0.32, 0.55, 0.05); this.ra.scale.set(0.9, 0.7, 0.9);
    this.group.add(this.ra);

    const arch = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.05, 0.55, 0.0),
      new THREE.Vector3(-0.10, 1.10, 0.05),
      new THREE.Vector3( 0.45, 1.25, 0.05),
      new THREE.Vector3( 0.65, 0.95, 0.0),
      new THREE.Vector3( 0.55, 0.40, 0.0)
    ]);
    this.aorta = new THREE.Mesh(
      new THREE.TubeGeometry(arch, 64, 0.10, 16, false), this.matAorta);
    this.group.add(this.aorta);

    const pulm = new THREE.CatmullRomCurve3([
      new THREE.Vector3( 0.10, 0.55, 0.10),
      new THREE.Vector3( 0.15, 0.95, 0.20),
      new THREE.Vector3(-0.20, 1.10, 0.25)
    ]);
    this.pulm = new THREE.Mesh(
      new THREE.TubeGeometry(pulm, 48, 0.08, 14, false), this.matVein);
    this.group.add(this.pulm);

    const svc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.55, 18), this.matVein);
    svc.position.set(0.45, 0.95, 0.05); this.group.add(svc);
    const ivc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 18), this.matVein);
    ivc.position.set(0.42, 0.05, 0.05); this.group.add(ivc);

    this.group.scale.setScalar(1.15);

    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 2.4, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff5b6d, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      })
    );
    this.halo.rotation.x = Math.PI * 0.5;
    scene.add(this.halo);
  }

  update(dt, bpm, color, stress) {
    this.bpm = bpm;
    this.cycleT = (this.cycleT + dt * (bpm / 60)) % 1.0;
    const env = ventricularEnvelope(this.cycleT);
    this.envelope = env;

    const ampVent = 0.10 + 0.18 * stress;
    const v = 1.0 - ampVent * 0.6  * env;
    const w = 1.0 + ampVent * 0.25 * env;
    this.lv.scale.set(0.95 * w, 1.25 * v, 0.95 * w);
    this.rv.scale.set(0.95 * w, 1.15 * v, 0.9  * w);
    this.apex.scale.set(1.0,    1.0 - ampVent * 0.4 * env, 1.0);

    const atrialPhase = (this.cycleT > 0.55)
      ? Math.sin((this.cycleT - 0.55) / 0.15 * Math.PI) : 0;
    const atrialA = Math.max(0, atrialPhase) * (0.06 + 0.05 * stress);
    this.la.scale.set(0.9 * (1 - atrialA), 0.7 * (1 - atrialA), 0.9 * (1 - atrialA));
    this.ra.scale.set(0.9 * (1 - atrialA), 0.7 * (1 - atrialA), 0.9 * (1 - atrialA));

    this.group.scale.setScalar(1.15 * (1.0 + 0.04 * env));
    this.group.rotation.y += dt * 0.12;

    const targetEm = color.clone().multiplyScalar(0.4 + 1.6 * stress);
    for (const m of [this.mat, this.matAtria, this.matAorta]) {
      m.emissive.lerp(targetEm, 0.05);
      m.emissiveIntensity = 0.25 + 0.6 * env + 0.4 * stress;
    }

    this.halo.material.opacity = 0.10 + 0.45 * Math.max(0, env) + 0.15 * stress;
    this.halo.material.color.lerp(color, 0.05);
    this.halo.scale.setScalar(1.0 + 0.18 * Math.max(0, env) + 0.20 * stress);
  }
}