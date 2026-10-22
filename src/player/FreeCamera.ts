import * as THREE from 'three';
import type { Bounds } from '../core/types';
import type { Input } from '../core/Input';

const MIN_SPEED = 5;
const MAX_SPEED = 240;

/**
 * Noclip fly camera: mouse to look, WASD along the view direction, E/Space up, Q/C down,
 * Shift to boost, wheel to change cruise speed.
 */
export class FreeCamera {
  yaw = 0;
  /** Positive looks up. */
  pitch = 0;
  speed = 40;
  readonly velocity = new THREE.Vector3();
  sensitivity = 0.0022;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly bounds: Bounds) {}

  /** Takes over from the current camera pose without a jump. */
  enter(): void {
    const dir = this.camera.getWorldDirection(this.forward);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.velocity.set(0, 0, 0);
  }

  update(dt: number, input: Input): void {
    this.yaw -= input.mouseDX * this.sensitivity;
    this.pitch -= input.mouseDY * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.55, 1.55);
    if (input.wheel) this.speed = THREE.MathUtils.clamp(this.speed * (1 - input.wheel * 0.15), MIN_SPEED, MAX_SPEED);

    const cp = Math.cos(this.pitch);
    this.forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const w = this.wish.set(0, 0, 0);
    if (input.down('KeyW') || input.down('ArrowUp')) w.add(this.forward);
    if (input.down('KeyS') || input.down('ArrowDown')) w.sub(this.forward);
    if (input.down('KeyD') || input.down('ArrowRight')) w.add(this.right);
    if (input.down('KeyA') || input.down('ArrowLeft')) w.sub(this.right);
    if (input.down('KeyE') || input.down('Space')) w.y += 1;
    if (input.down('KeyQ') || input.down('KeyC')) w.y -= 1;
    if (w.lengthSq() > 0) w.normalize().multiplyScalar(this.speed * (input.down('ShiftLeft') || input.down('ShiftRight') ? 4 : 1));

    // critically damped approach to the wished velocity: snappy but smooth
    this.velocity.lerp(w, 1 - Math.exp(-6 * dt));
    const p = this.camera.position.addScaledVector(this.velocity, dt);

    const b = this.bounds, m = 800;
    p.x = THREE.MathUtils.clamp(p.x, b.minX - m, b.maxX + m);
    p.z = THREE.MathUtils.clamp(p.z, b.minZ - m, b.maxZ + m);
    p.y = THREE.MathUtils.clamp(p.y, 0.6, 1800);

    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Heading in the player's "facing" convention, for the minimap arrow. */
  get facing(): number {
    return this.yaw + Math.PI;
  }
}
