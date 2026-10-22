import { closestOnSegment, pointInRing, SpatialGrid, toRing } from './geom';
import type { Bounds, MapData, Vec2 } from './types';

interface Solid {
  ring: Vec2[];
  minY: number;
  maxY: number;
  /** Water blocks walking but not the camera. */
  water: boolean;
  stamp: number;
}

interface Edge { ax: number; az: number; bx: number; bz: number; solid: Solid }

const tmp: Vec2 = [0, 0];

/**
 * 2.5D collision world: building footprints and lakes extruded vertically.
 * The player is a vertical cylinder resolved against footprint edges.
 */
export class CollisionWorld {
  private edges = new SpatialGrid<Edge>(16);
  private solids = new SpatialGrid<Solid>(32);
  private stamp = 0;

  constructor(readonly bounds: Bounds) {}

  static fromMap(map: MapData): CollisionWorld {
    const world = new CollisionWorld(map.bounds);
    for (const b of map.buildings) world.addSolid(toRing(b.p), b.m ?? 0, b.h, false);
    for (const a of map.areas) if (a.k === 'water') world.addSolid(toRing(a.p), -5, 0.5, true);
    return world;
  }

  addSolid(ring: Vec2[], minY: number, maxY: number, water: boolean): void {
    const solid: Solid = { ring, minY, maxY, water, stamp: 0 };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const e: Edge = { ax: a[0], az: a[1], bx: b[0], bz: b[1], solid };
      this.edges.insert(e, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      x0 = Math.min(x0, a[0]); z0 = Math.min(z0, a[1]); x1 = Math.max(x1, a[0]); z1 = Math.max(z1, a[1]);
    }
    this.solids.insert(solid, x0, z0, x1, z1);
  }

  /** Is the point inside any solid volume? */
  isSolid(x: number, y: number, z: number, includeWater = true): boolean {
    let hit = false;
    this.solids.forEachIn(x, z, x, z, (s) => {
      if (hit || (!includeWater && s.water)) return;
      if (y >= s.minY && y <= s.maxY && pointInRing(x, z, s.ring)) hit = true;
    });
    return hit;
  }

  /**
   * Pushes a vertical cylinder (radius r, feet at pos.y, given height) out of all solids.
   * Mutates pos in place. Returns true if any contact happened.
   */
  resolve(pos: { x: number; y: number; z: number }, r: number, height: number): boolean {
    let contact = false;
    const stamp = ++this.stamp;
    // Escape from inside a footprint first (spawn, or tunnelling at very low frame rates).
    this.solids.forEachIn(pos.x, pos.z, pos.x, pos.z, (s) => {
      if (s.stamp === stamp) return;
      s.stamp = stamp;
      if (!this.blocks(s, pos.y, height) || !pointInRing(pos.x, pos.z, s.ring)) return;
      let best = Infinity, bx = 0, bz = 0;
      for (let i = 0; i < s.ring.length; i++) {
        const a = s.ring[i], b = s.ring[(i + 1) % s.ring.length];
        const d = closestOnSegment(pos.x, pos.z, a[0], a[1], b[0], b[1], tmp);
        if (d < best) { best = d; bx = tmp[0]; bz = tmp[1]; }
      }
      const dx = bx - pos.x, dz = bz - pos.z;
      const len = Math.hypot(dx, dz) || 1;
      pos.x = bx + (dx / len) * r * 1.01;
      pos.z = bz + (dz / len) * r * 1.01;
      contact = true;
    });

    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      this.edges.forEachIn(pos.x - r, pos.z - r, pos.x + r, pos.z + r, (e) => {
        if (!this.blocks(e.solid, pos.y, height)) return;
        const d2 = closestOnSegment(pos.x, pos.z, e.ax, e.az, e.bx, e.bz, tmp);
        if (d2 >= r * r || d2 < 1e-10) return;
        const d = Math.sqrt(d2);
        const push = r - d;
        pos.x += ((pos.x - tmp[0]) / d) * push;
        pos.z += ((pos.z - tmp[1]) / d) * push;
        moved = true;
      });
      if (!moved) break;
      contact = true;
    }

    const b = this.bounds, m = 5;
    pos.x = Math.min(b.maxX - m, Math.max(b.minX + m, pos.x));
    pos.z = Math.min(b.maxZ - m, Math.max(b.minZ + m, pos.z));
    return contact;
  }

  /**
   * Marches from `from` toward `to` and returns the fraction (0..1) of the way that is free
   * of building volumes. Keeps the third-person camera out of walls.
   */
  castCamera(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, step = 0.4): number {
    const dx = tx - fx, dy = ty - fy, dz = tz - fz;
    const len = Math.hypot(dx, dy, dz);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (this.isSolid(fx + dx * t, fy + dy * t, fz + dz * t, false)) return Math.max(0, (i - 1) / n);
    }
    return 1;
  }

  private blocks(s: Solid, y: number, height: number): boolean {
    return y < s.maxY && y + height > s.minY;
  }
}
