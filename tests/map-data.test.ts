import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/core/Collision';
import type { MapData } from '../src/core/types';

const map = JSON.parse(readFileSync(new URL('../public/data/nanning.json', import.meta.url), 'utf8')) as MapData;

describe('generated Nanning map', () => {
  it('contains the requested landmarks', () => {
    const names = new Set([...map.areas, ...map.buildings].map((x) => x.n).filter(Boolean));
    expect(names).toContain('南宁国际会展中心');
    expect(names).toContain('石门森林公园');
    expect(map.labels.some((l) => l.n === '东盟商务区')).toBe(true);
  });

  it('includes the main roads from the reference screenshot', () => {
    const roads = new Set(map.roads.map((r) => r.n));
    for (const name of ['民族大道', '竹溪大道', '青秀路', '桂雅路', '越秀路', '中泰路', '合作路']) expect(roads).toContain(name);
  });

  it('has a plausible amount of city content', () => {
    expect(map.buildings.length).toBeGreaterThan(500);
    expect(map.roads.length).toBeGreaterThan(200);
    expect(map.trees.length / 4).toBeGreaterThan(1000);
    expect(map.buildings.every((b) => b.h > 0 && b.p.length >= 6)).toBe(true);
  });

  it('gives 南宁华润大厦 its real ~403 m height', () => {
    const tower = map.buildings.find((b) => b.n === '南宁华润大厦A座');
    expect(tower?.h).toBeGreaterThan(400);
  });

  it('spawns on 民族大道 outside any building', () => {
    const station = map.labels.find((l) => l.n.includes('万象城站'))!;
    const world = CollisionWorld.fromMap(map);
    expect(world.isSolid(station.x, 1, station.z)).toBe(false);
  });
});
