import type { Vec2 } from './types';

export function toRing(flat: number[]): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
  return ring;
}

export function signedArea(ring: Vec2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}

export function pointInRing(x: number, z: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(ring: Vec2[]): Vec2 {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}

/** Closest point on segment ab to p, written into out. Returns squared distance. */
export function closestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out: Vec2): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = ax + t * dx;
  out[1] = az + t * dz;
  const ex = px - out[0], ez = pz - out[1];
  return ex * ex + ez * ez;
}

/** Deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform spatial hash keyed by integer cell coordinates. */
export class SpatialGrid<T> {
  private cells = new Map<number, T[]>();
  constructor(readonly cellSize: number) {}

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  insert(item: T, x0: number, z0: number, x1: number, z1: number): void {
    const c = this.cellSize;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const k = this.key(i, j);
        const arr = this.cells.get(k);
        if (arr) arr.push(item);
        else this.cells.set(k, [item]);
      }
  }

  /** Calls fn for every item in the cells overlapping the box (items may repeat across cells). */
  forEachIn(x0: number, z0: number, x1: number, z1: number, fn: (item: T) => void): void {
    const c = this.cellSize;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const arr = this.cells.get(this.key(i, j));
        if (arr) for (let n = 0; n < arr.length; n++) fn(arr[n]);
      }
  }
}
