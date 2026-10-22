import * as THREE from 'three';
import type { CollisionWorld } from '../core/Collision';
import type { Input } from '../core/Input';

/** Orbiting third-person camera that pulls in when a building is in the way. */
export class CameraRig {
  yaw = 0;
  pitch = 0.32;
  distance = 7;
  private current = 7;
  private readonly target = new THREE.Vector3();
  sensitivity = 0.0022;

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly world: CollisionWorld) {}

  update(dt: number, input: Input, focus: THREE.Vector3): void {
    this.yaw -= input.mouseDX * this.sensitivity;
    this.pitch += input.mouseDY * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.35, 1.35);
    if (input.wheel) this.distance = THREE.MathUtils.clamp(this.distance * (1 + input.wheel * 0.12), 2.5, 40);
    if (input.down('KeyQ')) this.yaw += dt * 1.8;
    if (input.down('KeyE')) this.yaw -= dt * 1.8;

    // smooth follow of the head position
    const t = 1 - Math.exp(-18 * dt);
    this.target.lerp(new THREE.Vector3(focus.x, focus.y + 1.55, focus.z), this.target.lengthSq() === 0 ? 1 : t);

    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const tgt = this.target;
    const want = tgt.clone().addScaledVector(dir, this.distance);
    const free = this.world.castCamera(tgt.x, tgt.y, tgt.z, want.x, want.y, want.z);
    const allowed = Math.max(0.8, this.distance * free - 0.3);
    // snap in quickly, ease back out
    this.current += (allowed - this.current) * (allowed < this.current ? 1 - Math.exp(-30 * dt) : 1 - Math.exp(-3 * dt));
    this.camera.position.copy(tgt).addScaledVector(dir, this.current);
    if (this.camera.position.y < 0.3) this.camera.position.y = 0.3;
    this.camera.lookAt(tgt);
  }
}
