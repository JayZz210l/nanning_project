import * as THREE from 'three';
import type { CollisionWorld } from '../core/Collision';
import type { Input } from '../core/Input';
import { Character } from './Character';

const WALK = 4.2;
const RUN = 9.5;
const ACCEL = 14;
const GRAVITY = 22;
const JUMP = 6.8;
const RADIUS = 0.35;
const HEIGHT = 1.8;

/** Third-person character controller: WASD relative to camera yaw, Shift to run, Space to jump. */
export class Player {
  readonly character = new Character();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  facing = 0;
  grounded = true;
  speed = 0;

  constructor(private readonly world: CollisionWorld) {}

  get object(): THREE.Object3D {
    return this.character.root;
  }

  teleport(x: number, z: number): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.world.resolve(this.position, RADIUS, HEIGHT);
    this.sync();
  }

  update(dt: number, input: Input, cameraYaw: number, time: number): void {
    let ix = 0, iz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) iz -= 1;
    if (input.down('KeyS') || input.down('ArrowDown')) iz += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) ix -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) ix += 1;
    const len = Math.hypot(ix, iz);
    const running = input.down('ShiftLeft') || input.down('ShiftRight');
    const target = len > 0 ? (running ? RUN : WALK) : 0;

    // camera-relative direction (camera looks toward -z at yaw 0)
    let dx = 0, dz = 0;
    if (len > 0) {
      ix /= len; iz /= len;
      const c = Math.cos(cameraYaw), s = Math.sin(cameraYaw);
      dx = ix * c + iz * s;
      dz = -ix * s + iz * c;
    }

    const control = this.grounded ? 1 : 0.35;
    const k = 1 - Math.exp(-ACCEL * control * dt);
    this.velocity.x += (dx * target - this.velocity.x) * k;
    this.velocity.z += (dz * target - this.velocity.z) * k;

    if (this.grounded && input.hit('Space')) {
      this.velocity.y = JUMP;
      this.grounded = false;
    }
    this.velocity.y -= GRAVITY * dt;

    // substeps keep fast movement from skipping through thin walls
    const steps = Math.max(1, Math.ceil((Math.hypot(this.velocity.x, this.velocity.z) * dt) / (RADIUS * 0.8)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const px = this.position.x, pz = this.position.z;
      this.position.x += this.velocity.x * h;
      this.position.z += this.velocity.z * h;
      this.position.y += this.velocity.y * h;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.velocity.y = 0;
        this.grounded = true;
      }
      if (this.world.resolve(this.position, RADIUS, HEIGHT)) {
        // keep only the velocity that actually happened (slide along walls)
        this.velocity.x = (this.position.x - px) / h;
        this.velocity.z = (this.position.z - pz) / h;
      }
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.speed > 0.3) {
      const want = Math.atan2(this.velocity.x, this.velocity.z);
      let d = want - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * (1 - Math.exp(-12 * dt));
    }
    this.character.animate(dt, this.speed, !this.grounded, time, this.position.y);
    this.sync();
  }

  private sync(): void {
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = this.facing;
  }
}
