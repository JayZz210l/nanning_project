import * as THREE from 'three';

/** A limb that rotates around a joint at its top. */
function limb(len: number, radius: number, mat: THREE.Material): { pivot: THREE.Group; lower: THREE.Group } {
  const pivot = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len / 2 - radius, 3, 8), mat);
  upper.position.y = -len / 4;
  pivot.add(upper);
  const lower = new THREE.Group();
  lower.position.y = -len / 2;
  const lm = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.9, len / 2 - radius, 3, 8), mat);
  lm.position.y = -len / 4;
  lower.add(lm);
  pivot.add(lower);
  return { pivot, lower };
}

/** Low-poly runner in a dark jacket with neon trims, animated procedurally. */
export class Character {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legs: { pivot: THREE.Group; lower: THREE.Group }[] = [];
  private arms: { pivot: THREE.Group; lower: THREE.Group }[] = [];
  private head = new THREE.Group();
  private phase = 0;

  constructor() {
    const jacket = new THREE.MeshLambertMaterial({ color: 0x1b1e2b });
    const pants = new THREE.MeshLambertMaterial({ color: 0x24262e });
    const skin = new THREE.MeshLambertMaterial({ color: 0xe0b08a });
    const neon = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.4, 3.0) });
    const pink = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.4, 1.6) });
    const shoe = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });

    this.root.add(this.body);

    // torso
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.36, 4, 10), jacket);
    torso.scale.set(1.15, 1, 0.8);
    torso.position.y = 1.22;
    this.body.add(torso);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.02), neon);
    stripe.position.set(0.09, 1.24, 0.17);
    this.body.add(stripe);
    const stripe2 = stripe.clone();
    stripe2.position.x = -0.09;
    stripe2.material = pink;
    this.body.add(stripe2);
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.38, 0.14), new THREE.MeshLambertMaterial({ color: 0x2c2f3d }));
    backpack.position.set(0, 1.26, -0.2);
    this.body.add(backpack);
    const packLight = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.01), pink);
    packLight.position.set(0, 1.32, -0.275);
    this.body.add(packLight);

    // head with a glowing visor
    this.head.position.y = 1.62;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), skin);
    skull.scale.set(1, 1.1, 1);
    this.head.add(skull);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.1), new THREE.MeshLambertMaterial({ color: 0x15151a }));
    hair.position.y = 0.02;
    hair.rotation.x = -0.25;
    this.head.add(hair);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.08), neon);
    visor.position.set(0, 0.02, 0.1);
    this.head.add(visor);
    this.body.add(this.head);

    // legs
    for (const side of [-1, 1]) {
      const l = limb(0.84, 0.075, pants);
      l.pivot.position.set(0.1 * side, 0.92, 0);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.24), shoe);
      foot.position.set(0, -0.4, 0.05);
      l.lower.add(foot);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.015, 0.25), side < 0 ? neon : pink);
      sole.position.set(0, -0.44, 0.05);
      l.lower.add(sole);
      this.body.add(l.pivot);
      this.legs.push(l);
    }
    // arms
    for (const side of [-1, 1]) {
      const a = limb(0.62, 0.055, jacket);
      a.pivot.position.set(0.27 * side, 1.47, 0);
      a.pivot.rotation.z = 0.08 * side;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), skin);
      hand.position.y = -0.31;
      a.lower.add(hand);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 8), side < 0 ? neon : pink);
      cuff.position.y = -0.26;
      a.lower.add(cuff);
      this.body.add(a.pivot);
      this.arms.push(a);
    }

    // soft blob shadow
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    shadow.position.y = 0.03;
    shadow.renderOrder = -10;
    this.root.add(shadow);
    this.shadow = shadow;
  }

  private shadow: THREE.Mesh;

  /**
   * @param speed horizontal speed in m/s
   * @param airborne whether the character is in the air
   */
  animate(dt: number, speed: number, airborne: boolean, time: number, height: number): void {
    const run = Math.min(1, speed / 9);
    const moving = Math.min(1, speed / 1.5);
    // stride frequency grows with speed (about 1.6 Hz walking to 2.8 Hz sprinting)
    this.phase += dt * (5 + run * 8) * moving;
    const s = Math.sin(this.phase);
    const swing = (0.45 + run * 0.5) * moving;

    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? 1 : -1;
      const leg = this.legs[i], arm = this.arms[i];
      if (airborne) {
        leg.pivot.rotation.x = THREE.MathUtils.lerp(leg.pivot.rotation.x, i === 0 ? -0.7 : 0.25, 0.2);
        leg.lower.rotation.x = THREE.MathUtils.lerp(leg.lower.rotation.x, i === 0 ? 1.1 : 0.4, 0.2);
        arm.pivot.rotation.x = THREE.MathUtils.lerp(arm.pivot.rotation.x, -1.2, 0.15);
        arm.lower.rotation.x = -0.4;
        continue;
      }
      leg.pivot.rotation.x = -s * dir * swing;
      leg.lower.rotation.x = Math.max(0, Math.sin(this.phase + (dir > 0 ? 0 : Math.PI) - 0.9)) * (0.3 + run * 1.1) * moving;
      arm.pivot.rotation.x = s * dir * swing * 0.9;
      arm.lower.rotation.x = -(0.25 + run * 0.9) * (0.4 + moving * 0.6);
    }
    const bob = airborne ? 0 : Math.abs(Math.cos(this.phase)) * 0.06 * moving;
    const idle = Math.sin(time * 2) * 0.008 * (1 - moving);
    this.body.position.y = bob + idle;
    this.body.rotation.x = run * 0.22 * moving;
    this.head.rotation.x = -run * 0.15 * moving;
    // shadow stays on the ground and shrinks while airborne
    this.shadow.position.y = 0.03 - height;
    const k = Math.max(0.4, 1 - height * 0.25);
    this.shadow.scale.set(k, 1, k);
  }
}
