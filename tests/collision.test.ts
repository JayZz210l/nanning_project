import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/core/Collision';
import type { Vec2 } from '../src/core/types';

const bounds = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
const square = (cx: number, cz: number, s: number): Vec2[] => [
  [cx - s, cz - s], [cx + s, cz - s], [cx + s, cz + s], [cx - s, cz + s],
];

describe('CollisionWorld', () => {
  it('pushes a player standing against a wall back out to its radius', () => {
    const w = new CollisionWorld(bounds);
    w.addSolid(square(0, 0, 10), 0, 50, false);
    const pos = { x: 10.1, y: 0, z: 0 };
    expect(w.resolve(pos, 0.35, 1.8)).toBe(true);
    expect(pos.x).toBeCloseTo(10.35, 3);
  });

  it('ejects a player that starts inside a footprint', () => {
    const w = new CollisionWorld(bounds);
    w.addSolid(square(0, 0, 10), 0, 50, false);
    const pos = { x: 8, y: 0, z: 1 };
    w.resolve(pos, 0.35, 1.8);
    expect(w.isSolid(pos.x, 1, pos.z)).toBe(false);
    expect(pos.x).toBeGreaterThan(10);
  });

  it('ignores raised building parts above head height', () => {
    const w = new CollisionWorld(bounds);
    w.addSolid(square(0, 0, 10), 6, 30, false);
    const pos = { x: 0, y: 0, z: 0 };
    expect(w.resolve(pos, 0.35, 1.8)).toBe(false);
  });

  it('lets the camera pass over water but not through buildings', () => {
    const w = new CollisionWorld(bounds);
    w.addSolid(square(20, 0, 5), -5, 0.5, true);
    w.addSolid(square(60, 0, 5), 0, 40, false);
    expect(w.castCamera(0, 2, 0, 40, 2, 0)).toBe(1);
    expect(w.castCamera(0, 2, 0, 80, 2, 0)).toBeLessThan(0.71);
  });

  it('keeps the player inside the map bounds', () => {
    const w = new CollisionWorld(bounds);
    const pos = { x: 900, y: 0, z: -900 };
    w.resolve(pos, 0.35, 1.8);
    expect(pos.x).toBeLessThanOrEqual(495);
    expect(pos.z).toBeGreaterThanOrEqual(-495);
  });
});
