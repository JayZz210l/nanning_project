// Converts data/osm-raw.json (Overpass output) into public/data/nanning.json, the compact
// game map: buildings, roads, areas, trees, street lights and labels in local meters.
// x = east, z = south (three.js convention: north is -z).
//
// OSM only maps a fraction of the real buildings here, so named residential compounds and
// commercial plots are filled with procedural towers that respect roads, parks and water.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { BBOX, ORIGIN } from './area.mjs';

const raw = JSON.parse(await readFile(new URL('../data/osm-raw.json', import.meta.url), 'utf8'));

// ---------- projection ----------
const LAT_M = 110574;
const LON_M = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const project = (lat, lon) => [(lon - ORIGIN.lon) * LON_M, (ORIGIN.lat - lat) * LAT_M];
const [minX, maxZ] = project(BBOX.south, BBOX.west);
const [maxX, minZ] = project(BBOX.north, BBOX.east);
const bounds = { minX, maxX, minZ, maxZ };
const MARGIN = 120;
const inExtended = ([x, z]) =>
  x > minX - MARGIN && x < maxX + MARGIN && z > minZ - MARGIN && z < maxZ + MARGIN;
const inBounds = ([x, z], m = 0) => x > minX + m && x < maxX - m && z > minZ + m && z < maxZ - m;

// ---------- rng ----------
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261022);
const range = (r, a, b) => a + (b - a) * r();

// ---------- geometry helpers ----------
function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}
function centroid(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}
function pointInRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPoly(p, poly) {
  if (!pointInRing(p, poly.outer)) return false;
  for (const h of poly.holes) if (pointInRing(p, h)) return false;
  return true;
}
function distToSeg([px, pz], [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
function bbox(ring) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of ring) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
  return [a, b, c, d];
}
function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
function ringsOverlap(a, b) {
  if (pointInRing(a[0], b) || pointInRing(b[0], a)) return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}
function closeRing(ring) {
  const r = ring.slice();
  const f = r[0], l = r[r.length - 1];
  if (f[0] === l[0] && f[1] === l[1]) r.pop();
  return r;
}
function simplify(ring, eps = 0.3) {
  // drop near-duplicate and collinear vertices
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  return out;
}
function rectRing(cx, cz, w, d, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [
    cx + x * c - z * s,
    cz + x * s + z * c,
  ]);
}
function dominantAngle(ring) {
  let best = 0, ang = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return ang;
}

// Spatial hash for fast proximity queries.
class Grid {
  constructor(cell = 40) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  insert(item, [x0, z0, x1, z1]) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const k = this.key(i, j);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(item);
      }
  }
  query([x0, z0, x1, z1]) {
    const c = this.cell, out = new Set();
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const arr = this.map.get(this.key(i, j));
        if (arr) for (const it of arr) out.add(it);
      }
    return out;
  }
}

// ---------- OSM assembly ----------
const nodes = new Map();
const ways = new Map();
for (const e of raw.elements) {
  if (e.type === 'node') nodes.set(e.id, e);
  else if (e.type === 'way') ways.set(e.id, e);
}
const wayCoords = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => project(n.lat, n.lon));

function stitchRings(memberWays) {
  const segs = memberWays.map(wayCoords).filter((s) => s.length > 1);
  const rings = [];
  const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  while (segs.length) {
    let ring = segs.shift();
    let progress = true;
    while (!eq(ring[0], ring[ring.length - 1]) && progress) {
      progress = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        if (eq(end, s[0])) ring = ring.concat(s.slice(1));
        else if (eq(end, s[s.length - 1])) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (ring.length > 3) rings.push(closeRing(ring));
  }
  return rings;
}

/** Returns [{outer, holes, tags, id}] for closed ways and multipolygon relations. */
function polygonsOf(e) {
  if (e.type === 'way') {
    if (e.nodes.length < 4 || e.nodes[0] !== e.nodes[e.nodes.length - 1]) return [];
    return [{ outer: closeRing(wayCoords(e)), holes: [], tags: e.tags, id: e.id }];
  }
  if (e.type === 'relation' && e.tags?.type === 'multipolygon') {
    const outerW = [], innerW = [];
    for (const m of e.members) {
      const w = m.type === 'way' && ways.get(m.ref);
      if (!w) continue;
      (m.role === 'inner' ? innerW : outerW).push(w);
    }
    const outers = stitchRings(outerW), inners = stitchRings(innerW);
    return outers.map((outer) => ({
      outer,
      holes: inners.filter((h) => pointInRing(h[0], outer)),
      tags: e.tags,
      id: e.id,
    }));
  }
  return [];
}

const r1 = (v) => Math.round(v * 10) / 10;
const flat = (ring) => ring.flatMap(([x, z]) => [r1(x), r1(z)]);

// ---------- classification ----------
const AREA_KIND = {
  water: 'water', park: 'park', forest: 'forest', grass: 'grass', pitch: 'pitch', plaza: 'plaza',
  parking: 'parking', residential: 'residential', commercial: 'commercial', civic: 'civic', construction: 'construction',
};
function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.leisure === 'marina' && false) return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 'forest';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground' || t.landuse === 'orchard') return 'park';
  if (t.landuse === 'grass' || t.natural === 'grassland' || t.landuse === 'meadow' || t.natural === 'wetland' || t.landuse === 'village_green') return 'grass';
  if (t.leisure === 'pitch' || t.leisure === 'track' || t.leisure === 'stadium' || t.leisure === 'playground') return 'pitch';
  if ((t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square' || t.amenity === 'marketplace') return 'plaza';
  if (t.amenity === 'parking') return 'parking';
  if (t.amenity === 'exhibition_centre') return 'plaza';
  if (t.landuse === 'residential') return 'residential';
  if (t.landuse === 'commercial' || t.landuse === 'retail') return 'commercial';
  if (t.landuse === 'construction') return 'construction';
  if (['school', 'university', 'college', 'kindergarten', 'hospital', 'courthouse'].includes(t.amenity) ||
      ['governmental', 'civic_admin', 'education'].includes(t.landuse)) return 'civic';
  return null;
}

const ROAD_WIDTH = {
  motorway: 24, trunk: 24, primary: 20, secondary: 15, tertiary: 11, unclassified: 8, residential: 7,
  living_street: 6, service: 5, pedestrian: 6, footway: 2.4, path: 2, cycleway: 2.5, steps: 2.5, track: 3,
};
// road class codes used by the renderer: 0 major, 1 medium, 2 minor, 3 service, 4 foot
function roadClass(hw) {
  const base = hw.replace('_link', '');
  if (['motorway', 'trunk', 'primary'].includes(base)) return 0;
  if (['secondary', 'tertiary'].includes(base)) return 1;
  if (['unclassified', 'residential', 'living_street'].includes(base)) return 2;
  if (base === 'service' || base === 'track') return 3;
  if (['pedestrian', 'footway', 'path', 'cycleway', 'steps'].includes(base)) return 4;
  return -1;
}

function parseHeight(t) {
  const num = (v) => {
    const f = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(f) && f > 0 ? f : null;
  };
  return num(t.height) ?? num(t['fixme:height']) ?? (num(t['building:levels']) ? num(t['building:levels']) * 3.3 + 2 : null);
}

const buildings = [], roads = [], areas = [], trees = [], labels = [];
const buildingRings = []; // for overlap tests
const bGrid = new Grid(50);

function addBuilding(ring, h, kind, gen, name, minH = 0) {
  const rec = { p: flat(ring), h: r1(h), k: kind };
  if (minH > 0) rec.m = r1(minH);
  if (gen) rec.g = 1;
  if (name) rec.n = name;
  buildings.push(rec);
  const bb = bbox(ring);
  bGrid.insert(ring, bb);
  buildingRings.push(ring);
}

// Building kind codes: 0 office/commercial glass, 1 residential, 2 civic/low, 3 landmark
function buildingKind(t) {
  const b = t.building || t['building:part'];
  if (['apartments', 'residential', 'house', 'dormitory'].includes(b)) return 1;
  if (['office', 'commercial', 'retail', 'hotel'].includes(b) || t.shop || t.office || t.tourism === 'hotel') return 0;
  return 2;
}

for (const e of raw.elements) {
  const t = e.tags;
  if (!t || (e.type !== 'way' && e.type !== 'relation')) continue;

  // buildings
  if ((t.building && t.building !== 'no' && t.building !== 'construction') || t['building:part']) {
    for (const poly of polygonsOf(e)) {
      const ring = simplify(poly.outer);
      if (ring.length < 3 || !ring.some(inExtended)) continue;
      const a = Math.abs(area(ring));
      if (a < 12) continue;
      let h = parseHeight(t);
      const kind = /大厦|广场|中心/.test(t.name || '') ? 0 : buildingKind(t);
      if (!h) {
        if (t.amenity === 'exhibition_centre' || /区（/.test(t.name || '')) h = 24;
        else if (t.building === 'roof') h = 6;
        else if (kind === 0) h = a > 4000 ? range(rand, 18, 30) : range(rand, 45, 110);
        else if (kind === 1) h = range(rand, 50, 95);
        else h = a > 3000 ? range(rand, 12, 22) : range(rand, 15, 40);
      }
      const minH = parseFloat(t.min_height) || (parseFloat(t['building:min_level']) || 0) * 3.3;
      addBuilding(ring, h, h > 150 ? 3 : kind, false, t.name, minH);
    }
    continue;
  }

  // roads
  if (t.highway && e.type === 'way' && !t.area) {
    const cls = roadClass(t.highway);
    if (cls < 0 || t.tunnel === 'yes' || t.tunnel === 'building_passage' || parseInt(t.layer || '0') < 0) continue;
    let w = ROAD_WIDTH[t.highway.replace('_link', '')] ?? 6;
    if (t.highway.endsWith('_link')) w = Math.min(w, 8);
    const lanes = parseInt(t.lanes || '0');
    if (lanes > 0 && cls <= 2) w = Math.max(w * 0.6, lanes * 3.4 + 1);
    const pts = wayCoords(e);
    // keep runs of points that touch the extended bounds
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const rec = { p: flat(run), w: r1(w), c: cls };
        if (t.name) rec.n = t.name;
        if (t.oneway === 'yes') rec.o = 1;
        if (t.bridge === 'yes') rec.b = 1;
        roads.push(rec);
      }
      run = [];
    };
    for (let i = 0; i < pts.length; i++) {
      const keep = inExtended(pts[i]) || (i > 0 && inExtended(pts[i - 1])) || (i < pts.length - 1 && inExtended(pts[i + 1]));
      if (keep) run.push(pts[i]);
      else flush();
    }
    flush();
    continue;
  }

  // tree rows
  if (t.natural === 'tree_row' && e.type === 'way') {
    const pts = wayCoords(e);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < L; s += 8) trees.push([ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L, 1, 0]);
    }
    continue;
  }

  // areas
  const kind = areaKind(t);
  if (kind) {
    for (const poly of polygonsOf(e)) {
      const outer = simplify(poly.outer);
      if (outer.length < 3 || !outer.some(inExtended)) continue;
      areas.push({ outer, holes: poly.holes.map((h) => simplify(h)), kind, name: t.name, tags: t, id: e.id });
    }
  }
}

// Lone tree nodes
for (const n of nodes.values()) {
  if (n.tags?.natural === 'tree') {
    const p = project(n.lat, n.lon);
    if (inExtended(p)) trees.push([p[0], p[1], 1.1, 0]);
  }
}

// ---------- obstacle indexes for procedural placement ----------
const roadGrid = new Grid(40);
for (const r of roads) {
  const pts = [];
  for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = { a: pts[i], b: pts[i + 1], hw: r.w / 2, cls: r.c };
    roadGrid.insert(seg, bbox([pts[i], pts[i + 1]]).map((v, k) => v + (k < 2 ? -20 : 20)));
  }
}
function roadClearance(p) {
  // returns min(distance to road edge) - extra setback, negative = on/near road
  let best = Infinity;
  for (const s of roadGrid.query([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1])) {
    const setback = s.cls === 4 ? 0.6 : s.cls <= 1 ? 6 : 3;
    best = Math.min(best, distToSeg(p, s.a, s.b) - s.hw - setback);
  }
  return best;
}

const blockerKinds = new Set(['water', 'park', 'forest', 'grass', 'pitch', 'plaza', 'parking', 'construction']);
const blockGrid = new Grid(60);
for (const a of areas) if (blockerKinds.has(a.kind)) blockGrid.insert(a, bbox(a.outer));
function inBlocker(p, kinds = blockerKinds) {
  for (const a of blockGrid.query([p[0], p[1], p[0], p[1]])) if (kinds.has(a.kind) && pointInPoly(p, a)) return a;
  return null;
}
function hitsBuilding(ring, margin) {
  const [x0, z0, x1, z1] = bbox(ring);
  for (const b of bGrid.query([x0 - margin, z0 - margin, x1 + margin, z1 + margin])) {
    if (ringsOverlap(ring, b)) return true;
    if (margin > 0) for (const p of ring) for (let i = 0; i < b.length; i++) if (distToSeg(p, b[i], b[(i + 1) % b.length]) < margin) return true;
  }
  return false;
}

// ---------- procedural infill ----------
// CBD core (东盟商务区) roughly east of 青秀路 and north of 中泰路; towers there are taller.
const [cbdX] = project(22.81, 108.3878);
const [, cbdZ] = project(22.8085, 108.39);
const isCBD = ([x, z]) => x > cbdX && z < cbdZ;

let generated = 0;
const fillZones = areas
  .filter((a) => ['residential', 'commercial', 'civic'].includes(a.kind) && a.tags.amenity !== 'exhibition_centre')
  .sort((a, b) => Math.abs(area(b.outer)) - Math.abs(area(a.outer)));

for (const zone of fillZones) {
  const zArea = Math.abs(area(zone.outer));
  if (zArea < 900) continue;
  const zr = mulberry32(zone.id % 100000);
  const retail = zone.tags.landuse === 'retail';
  const c = centroid(zone.outer);
  let spec;
  if (zone.kind === 'residential') {
    const lowRise = zr() < 0.22 || /小区|新村|山庄/.test(zone.name || '');
    spec = lowRise
      ? { w: [28, 46], d: [11, 14], sx: 52, sz: 30, h: [16, 28], kind: 1 }
      : { w: [18, 26], d: [14, 19], sx: 44, sz: 46, h: [62, 112], kind: 1 };
  } else if (zone.kind === 'commercial') {
    spec = retail
      ? { w: [40, 70], d: [30, 50], sx: 75, sz: 65, h: [14, 26], kind: 0 }
      : isCBD(c)
        ? { w: [28, 42], d: [28, 40], sx: 58, sz: 58, h: [90, 220], kind: 0 }
        : { w: [26, 40], d: [22, 36], sx: 56, sz: 54, h: [45, 120], kind: 0 };
  } else {
    spec = { w: [30, 55], d: [14, 20], sx: 62, sz: 42, h: [12, 30], kind: 2 };
  }
  const ang = dominantAngle(zone.outer);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // local frame bbox
  const local = zone.outer.map(([x, z]) => [(x - c[0]) * ca + (z - c[1]) * sa, -(x - c[0]) * sa + (z - c[1]) * ca]);
  const [lx0, lz0, lx1, lz1] = bbox(local);
  const offX = zr() * spec.sx, offZ = zr() * spec.sz;
  for (let lx = lx0 + offX - spec.sx; lx < lx1; lx += spec.sx) {
    for (let lz = lz0 + offZ - spec.sz; lz < lz1; lz += spec.sz) {
      const jx = lx + range(zr, -4, 4), jz = lz + range(zr, -4, 4);
      const cx = c[0] + jx * ca - jz * sa, cz = c[1] + jx * sa + jz * ca;
      const w = range(zr, ...spec.w), d = range(zr, ...spec.d);
      const ring = rectRing(cx, cz, w, d, ang + (zr() < 0.1 ? Math.PI / 2 : 0));
      const probe = [...ring, [cx, cz], ...ring.map((p, i) => {
        const q = ring[(i + 1) % 4];
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      })];
      if (!probe.every((p) => pointInPoly(p, zone) && inBounds(p, 10))) continue;
      if (probe.some((p) => roadClearance(p) < 0)) continue;
      if (probe.some((p) => inBlocker(p))) continue;
      if (hitsBuilding(ring, 7)) continue;
      let h = range(zr, ...spec.h);
      if (spec.kind === 0 && isCBD(c) && zr() < 0.15) h *= 1.3;
      addBuilding(ring, h, spec.kind, true);
      generated++;
    }
  }
}

// ---------- trees ----------
const treeBlockers = new Set(['water', 'pitch', 'plaza', 'parking']);
function treeOk(p, roadMargin = 1.5) {
  if (!inBounds(p, 2)) return false;
  for (const s of roadGrid.query([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1]))
    if (distToSeg(p, s.a, s.b) < s.hw + roadMargin) return false;
  if (inBlocker(p, treeBlockers)) return false;
  for (const b of bGrid.query([p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3])) {
    if (pointInRing(p, b)) return false;
    for (let i = 0; i < b.length; i++) if (distToSeg(p, b[i], b[(i + 1) % b.length]) < 3) return false;
  }
  return true;
}
const TREE_SPACING = { forest: 7.5, park: 12, grass: 20, residential: 24, civic: 24, commercial: 38 };
for (const a of areas) {
  const sp = TREE_SPACING[a.kind];
  if (!sp) continue;
  const [x0, z0, x1, z1] = bbox(a.outer);
  for (let x = x0; x < x1; x += sp)
    for (let z = z0; z < z1; z += sp) {
      const p = [x + range(rand, -0.45, 0.45) * sp, z + range(rand, -0.45, 0.45) * sp];
      if (!pointInPoly(p, a) || !treeOk(p, a.kind === 'forest' ? 0.8 : 1.5)) continue;
      trees.push([p[0], p[1], range(rand, 0.75, 1.35), a.kind === 'forest' && rand() < 0.25 ? 2 : 0]);
    }
}
// Street trees (palms on the big boulevards, broadleaf elsewhere) and street lights.
const lights = [];
for (const r of roads) {
  if (r.c > 1 || r.b) continue;
  const pts = [];
  for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
  const off = r.w / 2 + 2.2;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.1) continue;
    const nx = -(bz - az) / L, nz = (bx - ax) / L;
    for (let s = (9 - acc) % 9; s < L; s += 9) {
      const px = ax + ((bx - ax) * s) / L, pz = az + ((bz - az) * s) / L;
      const idx = Math.round((acc + s) / 9);
      for (const side of [-1, 1]) {
        const p = [px + nx * off * side, pz + nz * off * side];
        if (idx % 4 === 0) {
          const lp = [px + nx * (r.w / 2 + 0.8) * side, pz + nz * (r.w / 2 + 0.8) * side];
          if (treeOk(lp, 0.3)) lights.push(r1(lp[0]), r1(lp[1]), r1(Math.atan2(-nx * side, -nz * side)));
        } else if (treeOk(p, 1.2)) {
          trees.push([p[0], p[1], range(rand, 0.85, 1.15), r.c === 0 ? 1 : 0]);
        }
      }
    }
    acc = (acc + L) % 9;
  }
}

// ---------- labels ----------
function addLabel(name, x, z, y, kind = 'landmark') {
  labels.push({ n: name, x: r1(x), z: r1(z), y: r1(y), k: kind });
}
const named = (re) => areas.find((a) => re.test(a.name || ''));
const bNamed = (re) => buildings.find((b) => re.test(b.n || ''));
const ringOf = (b) => { const r = []; for (let i = 0; i < b.p.length; i += 2) r.push([b.p[i], b.p[i + 1]]); return r; };
{
  const hz = named(/南宁国际会展中心/); if (hz) addLabel('南宁国际会展中心', ...centroid(hz.outer), 60);
  const sm = named(/石门森林公园/); if (sm) addLabel('石门森林公园', ...centroid(sm.outer), 40);
  const [cx, cz] = project(22.8115, 108.3955); addLabel('东盟商务区', cx, cz, 250);
  const hr = bNamed(/华润大厦A座/); if (hr) addLabel('南宁华润大厦 · 402.7m', ...centroid(ringOf(hr)), hr.h + 25);
  const sq = bNamed(/^三祺广场$/); if (sq) addLabel('三祺广场', ...centroid(ringOf(sq)), sq.h + 18);
  const wx = bNamed(/华润万象城/); if (wx) addLabel('万象城', ...centroid(ringOf(wx)), wx.h + 12);
  const dh = bNamed(/南宁人民大会堂/); if (dh) addLabel('南宁人民大会堂', ...centroid(ringOf(dh)), dh.h + 12);
  for (const lake of [/明湖/, /民歌湖/]) { const l = named(lake); if (l) addLabel(l.name, ...centroid(l.outer), 8, 'water'); }
}
for (const n of nodes.values()) {
  if (n.tags?.railway === 'station' && n.tags.name) {
    const p = project(n.lat, n.lon);
    if (inBounds(p)) addLabel('Ⓜ ' + n.tags.name.replace(/站$/, '') + '站', p[0], p[1], 6, 'metro');
  }
}

// ---------- output ----------
const AREA_ORDER = ['residential', 'commercial', 'civic', 'construction', 'parking', 'plaza', 'grass', 'park', 'forest', 'pitch', 'water'];
const outAreas = areas
  .filter((a) => AREA_KIND[a.kind])
  .sort((a, b) => AREA_ORDER.indexOf(a.kind) - AREA_ORDER.indexOf(b.kind))
  .map((a) => {
    const rec = { p: flat(a.outer), k: a.kind };
    if (a.holes.length) rec.h = a.holes.map(flat);
    if (a.name) rec.n = a.name;
    return rec;
  });

const out = {
  meta: {
    name: 'Cyber Nanning',
    source: '© OpenStreetMap contributors (ODbL)',
    origin: ORIGIN,
    bbox: BBOX,
    generatedAt: new Date().toISOString(),
  },
  bounds: { minX: r1(minX), maxX: r1(maxX), minZ: r1(minZ), maxZ: r1(maxZ) },
  buildings,
  roads,
  areas: outAreas,
  trees: trees.flatMap(([x, z, s, t]) => [r1(x), r1(z), Math.round(s * 100) / 100, t]),
  lights,
  labels,
};
await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const json = JSON.stringify(out);
await writeFile(new URL('../public/data/nanning.json', import.meta.url), json);
console.log(
  `buildings ${buildings.length} (${generated} generated), roads ${roads.length}, areas ${outAreas.length}, ` +
    `trees ${trees.length}, lights ${lights.length / 3}, labels ${labels.length}, ${(json.length / 1024).toFixed(0)} KB`,
);
console.log(`bounds x ${minX.toFixed(0)}..${maxX.toFixed(0)}  z ${minZ.toFixed(0)}..${maxZ.toFixed(0)}`);
