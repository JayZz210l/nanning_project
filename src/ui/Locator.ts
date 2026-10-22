import { closestOnSegment, pointInRing, signedArea, SpatialGrid, toRing } from '../core/geom';
import type { MapData, Vec2 } from '../core/types';

interface NamedArea { name: string; ring: Vec2[]; area: number }
interface NamedSeg { name: string; a: Vec2; b: Vec2; hw: number }

const tmp: Vec2 = [0, 0];

/** Answers "where am I": district, the named place you're in, and the nearest named road. */
export class Locator {
  private areas = new SpatialGrid<NamedArea>(100);
  private roads = new SpatialGrid<NamedSeg>(40);
  private parkRing: Vec2[] | null = null;
  private expoRing: Vec2[] | null = null;
  private cbdX: number;

  constructor(map: MapData) {
    for (const a of map.areas) {
      if (!a.n) continue;
      const ring = toRing(a.p);
      const item = { name: a.n, ring, area: Math.abs(signedArea(ring)) };
      if (a.n === '石门森林公园') this.parkRing = ring;
      if (a.n === '南宁国际会展中心') this.expoRing = ring;
      this.insertRing(item, ring);
    }
    for (const b of map.buildings) {
      if (!b.n || /^[A-Z]\d?$/.test(b.n)) continue;
      const ring = toRing(b.p);
      this.insertRing({ name: b.n, ring, area: Math.abs(signedArea(ring)) }, ring);
    }
    for (const r of map.roads) {
      if (!r.n || r.c > 3) continue;
      const pts = toRing(r.p);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        this.roads.insert({ name: r.n, a, b, hw: r.w / 2 }, Math.min(a[0], b[0]) - 30, Math.min(a[1], b[1]) - 30, Math.max(a[0], b[0]) + 30, Math.max(a[1], b[1]) + 30);
      }
    }
    // 青秀路 roughly separates the convention/park side from the ASEAN business district.
    const qx = map.roads.filter((r) => r.n === '青秀路').flatMap((r) => toRing(r.p).map((p) => p[0]));
    this.cbdX = qx.length ? qx.reduce((s, v) => s + v, 0) / qx.length - 20 : 120;
  }

  private insertRing(item: NamedArea, ring: Vec2[]): void {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    this.areas.insert(item, x0, z0, x1, z1);
  }

  locate(x: number, z: number): { district: string; place: string } {
    let district = x > this.cbdX ? '东盟商务区' : '凤岭 · 青秀区';
    if (this.expoRing && pointInRing(x, z, this.expoRing)) district = '南宁国际会展中心';
    if (this.parkRing && pointInRing(x, z, this.parkRing)) district = '石门森林公园';

    let place = '';
    let best = Infinity;
    this.areas.forEachIn(x, z, x, z, (a) => {
      if (a.area < best && a.name !== district && pointInRing(x, z, a.ring)) {
        best = a.area;
        place = a.name;
      }
    });
    if (!place) {
      let bestD = 25;
      this.roads.forEachIn(x, z, x, z, (s) => {
        const d = Math.sqrt(closestOnSegment(x, z, s.a[0], s.a[1], s.b[0], s.b[1], tmp)) - s.hw;
        if (d < bestD) { bestD = d; place = s.name; }
      });
    }
    return { district, place };
  }
}
