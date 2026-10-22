import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { centroid, mulberry32, signedArea, toRing } from '../core/geom';
import type { AreaKind, MapBuilding, MapData, Vec2 } from '../core/types';
import {
  createAreaMaterial,
  createBuildingMaterial,
  createGroundMaterial,
  createRoadMaterial,
  createFoliageMaterial,
  createWaterMaterial,
  shared,
} from './materials';

const AREA_COLORS: Record<AreaKind, number> = {
  residential: 0x4b4f52,
  commercial: 0x4f4c55,
  civic: 0x524e4a,
  construction: 0x6b5d47,
  parking: 0x3a3b40,
  plaza: 0x6b6670,
  grass: 0x4f7a3e,
  park: 0x3f7038,
  forest: 0x2c5a2c,
  pitch: 0x3d8a5a,
  water: 0x1d4a66,
};

// Painter's order for the flat ground layers (they never write depth, so no z-fighting).
const ORDER = { ground: -50, areas: -40, water: -35, roads: -30, glow: -20 };

/** Builds every static mesh of the city and adds it to a group. */
export class City {
  readonly group = new THREE.Group();
  readonly buildingCount: number;
  readonly treeCount: number;
  /** Tower tip positions used for blinking aircraft beacons. */
  private readonly beacons: THREE.Points;

  constructor(map: MapData) {
    const buildings = [...map.buildings, ...skylineBuildings(map)];
    this.buildingCount = map.buildings.length;
    this.group.add(this.buildGround(map));
    this.group.add(...this.buildAreas(map));
    this.group.add(this.buildRoads(map));
    this.group.add(this.buildBuildings(buildings));
    const trees = this.buildTrees(map);
    this.treeCount = trees.count;
    this.group.add(...trees.meshes);
    this.group.add(...this.buildLights(map));
    this.group.add(...this.buildLandmarks(map));
    this.beacons = this.buildBeacons(map.buildings);
    this.group.add(this.beacons);
  }

  update(time: number, night: number): void {
    const m = this.beacons.material as THREE.PointsMaterial;
    m.opacity = night * (Math.sin(time * 3) > 0.2 ? 1 : 0.15);
    this.beacons.visible = night > 0.05;
  }

  // ---------------------------------------------------------------- ground
  private buildGround(map: MapData): THREE.Mesh {
    const b = map.bounds;
    const geo = new THREE.PlaneGeometry(14000, 14000);
    geo.rotateX(-Math.PI / 2);
    geo.translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const mesh = new THREE.Mesh(geo, createGroundMaterial());
    mesh.renderOrder = ORDER.ground;
    mesh.frustumCulled = false;
    return mesh;
  }

  // ---------------------------------------------------------------- areas
  private buildAreas(map: MapData): THREE.Mesh[] {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const wpos: number[] = [], widx: number[] = [];
    const c = new THREE.Color();
    for (const a of map.areas) {
      const outer = toRing(a.p).map(([x, z]) => new THREE.Vector2(x, z));
      const holes = (a.h ?? []).map((h) => toRing(h).map(([x, z]) => new THREE.Vector2(x, z)));
      if (outer.length < 3) continue;
      let tris: number[][];
      try {
        tris = THREE.ShapeUtils.triangulateShape(outer, holes);
      } catch {
        continue;
      }
      const verts = outer.concat(...holes);
      const water = a.k === 'water';
      const P = water ? wpos : pos, I = water ? widx : idx;
      const base = P.length / 3;
      c.setHex(AREA_COLORS[a.k]);
      for (const v of verts) {
        P.push(v.x, 0, v.y);
        if (!water) col.push(c.r, c.g, c.b);
      }
      for (const t of tris) pushUp(I, P, base + t[0], base + t[1], base + t[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex(idx);
    const areas = new THREE.Mesh(geo, createAreaMaterial());
    areas.renderOrder = ORDER.areas;

    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    wgeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(wpos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    wgeo.setIndex(widx);
    const water = new THREE.Mesh(wgeo, createWaterMaterial());
    water.renderOrder = ORDER.water;
    return [areas, water];
  }

  // ---------------------------------------------------------------- roads
  private buildRoads(map: MapData): THREE.Mesh {
    const pos: number[] = [], uv: number[] = [], info: number[] = [], idx: number[] = [];
    const byClass: MapData['roads'][] = [[], [], [], [], []];
    for (const r of map.roads) byClass[r.c]?.push(r);

    const disc = (x: number, z: number, hw: number, cls: number) => {
      const seg = 14, base = pos.length / 3;
      pos.push(x, 0, z); uv.push(0, 0); info.push(cls, hw, 2);
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pos.push(x + Math.cos(a) * hw, 0, z + Math.sin(a) * hw);
        uv.push(0, 0);
        info.push(cls, hw, 2);
      }
      for (let i = 0; i < seg; i++) pushUp(idx, pos, base, base + 1 + i, base + 1 + ((i + 1) % seg));
    };

    const strip = (pts: Vec2[], hw: number, cls: number, flags: number) => {
      const n = pts.length;
      const base = pos.length / 3;
      let along = 0;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
        // averaged direction with miter scaling
        let d0x = p[0] - prev[0], d0z = p[1] - prev[1];
        let d1x = next[0] - p[0], d1z = next[1] - p[1];
        const l0 = Math.hypot(d0x, d0z) || 1, l1 = Math.hypot(d1x, d1z) || 1;
        d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
        if (i === 0) { d0x = d1x; d0z = d1z; }
        if (i === n - 1) { d1x = d0x; d1z = d0z; }
        let tx = d0x + d1x, tz = d0z + d1z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const nx = -tz, nz = tx;
        const cos = Math.max(0.5, nx * -d1z + nz * d1x);
        const w = hw / cos;
        if (i > 0) along += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        pos.push(p[0] - nx * w, 0, p[1] - nz * w, p[0] + nx * w, 0, p[1] + nz * w);
        uv.push(along, -1, along, 1);
        info.push(cls, hw, flags, cls, hw, flags);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        pushUp(idx, pos, a, a + 1, a + 2);
        pushUp(idx, pos, a + 1, a + 3, a + 2);
      }
    };

    // Draw minor classes first so major roads (and their markings) end up on top.
    for (let cls = 4; cls >= 0; cls--) {
      for (const r of byClass[cls]) {
        const pts = toRing(r.p);
        const hw = r.w / 2;
        if (cls <= 3) {
          disc(pts[0][0], pts[0][1], hw, cls);
          disc(pts[pts.length - 1][0], pts[pts.length - 1][1], hw, cls);
        }
      }
      for (const r of byClass[cls]) strip(toRing(r.p), r.w / 2, cls, r.o ? 1 : 0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(info, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, createRoadMaterial());
    mesh.renderOrder = ORDER.roads;
    return mesh;
  }

  // ---------------------------------------------------------------- buildings
  private buildBuildings(buildings: MapBuilding[]): THREE.Mesh {
    const pos: number[] = [], nor: number[] = [], met: number[] = [], inf: number[] = [], idx: number[] = [];
    const rand = mulberry32(7);
    for (const b of buildings) {
      let ring = toRing(b.p);
      if (ring.length < 3) continue;
      // Counter-clockwise in (x, z) so that (dz, -dx) is the outward wall normal.
      if (signedArea(ring) < 0) ring = ring.slice().reverse();
      const h = b.h, y0 = b.m ?? 0;
      const seed = rand();
      const kind = b.k;

      // walls
      let perim = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const nx = dz / len, nz = -dx / len;
        const base = pos.length / 3;
        pos.push(a[0], y0, a[1], c[0], y0, c[1], c[0], h, c[1], a[0], h, a[1]);
        for (let k = 0; k < 4; k++) { nor.push(nx, 0, nz); inf.push(seed, h, kind); }
        // snap each wall start to whole window columns so windows don't straddle corners
        const u0 = Math.round(perim / 3.3) * 3.3;
        met.push(u0, y0, u0 + len, y0, u0 + len, h, u0, h);
        pushFacing(idx, pos, base, base + 1, base + 2, nx, 0, nz);
        pushFacing(idx, pos, base, base + 2, base + 3, nx, 0, nz);
        perim += len;
      }

      // roof
      const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
      let tris: number[][];
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        continue;
      }
      const base = pos.length / 3;
      for (const [x, z] of ring) {
        pos.push(x, h, z); nor.push(0, 1, 0); met.push(x, z); inf.push(seed, h, kind);
      }
      for (const t of tris) pushUp(idx, pos, base + t[0], base + t[1], base + t[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aMeters', new THREE.Float32BufferAttribute(met, 2));
    geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(inf, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, createBuildingMaterial());
  }

  // ---------------------------------------------------------------- trees
  private buildTrees(map: MapData): { meshes: THREE.Object3D[]; count: number } {
    const t = map.trees;
    const groups: number[][] = [[], [], []];
    for (let i = 0; i < t.length; i += 4) groups[t[i + 3]]?.push(i);

    const flatShade = (g: THREE.BufferGeometry) => {
      const ng = g.index ? g.toNonIndexed() : g;
      ng.computeVertexNormals();
      return ng;
    };
    // broadleaf: squashed icosahedron crown on a short trunk
    const broadCrown = flatShade(new THREE.IcosahedronGeometry(1, 0)).scale(2.6, 2.2, 2.6).translate(0, 5.2, 0);
    // palm: fronds radiating from the top of a tall trunk
    const fronds: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const f = new THREE.ConeGeometry(0.55, 3.6, 3, 1).rotateZ(Math.PI / 2 + 0.35).translate(1.7, -0.35, 0).scale(1, 1, 0.35);
      fronds.push(f.rotateY((i / 7) * Math.PI * 2).translate(0, 8.2, 0));
    }
    const palmCrown = flatShade(mergeGeometries(fronds));
    const conCrown = flatShade(new THREE.ConeGeometry(2.2, 7, 6)).translate(0, 6, 0);
    const trunk = new THREE.CylinderGeometry(0.14, 0.24, 1, 5, 1, true).translate(0, 0.5, 0);

    const crownMat = createFoliageMaterial(0xffffff);
    const trunkMat = createFoliageMaterial(0x5a4636);
    const rand = mulberry32(99);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    const meshes: THREE.Object3D[] = [];
    const trunkH = [3.4, 8.2, 2.6];
    const crowns = [broadCrown, palmCrown, conCrown];
    const palettes = [
      [0x3b8a33, 0x4b9a3e, 0x33783a, 0x5aa046],
      [0x4fa046, 0x5fb04c, 0x46913f],
      [0x2a6a38, 0x347a40, 0x2f703a],
    ];
    let total = 0;
    for (let type = 0; type < 3; type++) {
      const list = groups[type];
      if (!list.length) continue;
      const crown = new THREE.InstancedMesh(crowns[type], crownMat, list.length);
      const tr = new THREE.InstancedMesh(trunk, trunkMat, list.length);
      list.forEach((i, n) => {
        const sc = t[i + 2] * (0.85 + rand() * 0.3);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        p.set(t[i], 0, t[i + 1]);
        s.set(sc, sc * (0.9 + rand() * 0.25), sc);
        m.compose(p, q, s);
        crown.setMatrixAt(n, m);
        c.setHex(palettes[type][Math.floor(rand() * palettes[type].length)]);
        crown.setColorAt(n, c);
        s.set(sc, trunkH[type] * sc, sc);
        m.compose(p, q, s);
        tr.setMatrixAt(n, m);
      });
      crown.computeBoundingSphere();
      tr.computeBoundingSphere();
      meshes.push(crown, tr);
      total += list.length;
    }
    return { meshes, count: total };
  }

  // ---------------------------------------------------------------- street lights
  private buildLights(map: MapData): THREE.Object3D[] {
    const l = map.lights;
    const n = l.length / 3;
    if (!n) return [];
    const pole = mergeGeometries([
      new THREE.CylinderGeometry(0.08, 0.12, 8, 5).translate(0, 4, 0),
      new THREE.BoxGeometry(0.08, 0.08, 1.8).translate(0, 7.9, 0.85),
    ]);
    const head = new THREE.BoxGeometry(0.35, 0.12, 0.7).translate(0, 7.8, 1.6);
    const poleMesh = new THREE.InstancedMesh(pole, new THREE.MeshLambertMaterial({ color: 0x30333a }), n);
    const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 1.1) });
    const headMesh = new THREE.InstancedMesh(head, headMat, n);

    // additive light pools on the road surface
    const poolGeo = new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      map: radialTexture(),
      color: new THREE.Color(1.0, 0.62, 0.32),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
    pools.renderOrder = ORDER.glow;

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = l[i * 3], z = l[i * 3 + 1], yaw = l[i * 3 + 2];
      q.setFromEuler(e.set(0, yaw, 0));
      m.compose(p.set(x, 0, z), q, one);
      poleMesh.setMatrixAt(i, m);
      headMesh.setMatrixAt(i, m);
      m.compose(p.set(x + Math.sin(yaw) * 1.6, 0.05, z + Math.cos(yaw) * 1.6), q, one);
      pools.setMatrixAt(i, m);
    }
    for (const mesh of [poleMesh, headMesh, pools]) mesh.computeBoundingSphere();
    pools.userData.nightOnly = true;
    headMesh.userData.nightOnly = true;
    return [poleMesh, headMesh, pools];
  }

  // ---------------------------------------------------------------- landmarks
  private buildLandmarks(map: MapData): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const find = (re: RegExp) => map.buildings.find((b) => re.test(b.n ?? ''));

    // 朱槿花 dome of the Nanning International Convention & Exhibition Centre
    const hall = find(/朱槿花厅/);
    if (hall) {
      const ring = toRing(hall.p);
      const [cx, cz] = centroid(ring);
      let r = 0;
      for (const [x, z] of ring) r = Math.max(r, Math.hypot(x - cx, z - cz));
      r *= 0.95;
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(r, 36, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        petalMaterial(),
      );
      dome.scale.y = 0.8;
      dome.position.set(cx, hall.h, cz);
      out.push(dome);
    }

    // spire on top of 南宁华润大厦 A (402.7 m)
    const tower = find(/华润大厦A座/);
    if (tower) {
      const [cx, cz] = centroid(toRing(tower.p));
      const spire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 2.2, 28, 6).translate(0, 14, 0),
        new THREE.MeshLambertMaterial({ color: 0x8899aa, emissive: 0x112244 }),
      );
      spire.position.set(cx, tower.h, cz);
      out.push(spire);
    }
    return out;
  }

  private buildBeacons(buildings: MapBuilding[]): THREE.Points {
    const pts: number[] = [];
    for (const b of buildings) {
      if (b.h < 120) continue;
      const [cx, cz] = centroid(toRing(b.p));
      pts.push(cx, b.h + (/华润大厦A座/.test(b.n ?? '') ? 29 : 1.5), cz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: new THREE.Color(3, 0.2, 0.2),
        size: 6,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
      }),
    );
  }
}

/** Pushes triangle (a, b, c) wound so that its face normal points along (nx, ny, nz). */
function pushFacing(idx: number[], pos: number[], a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * nx + cy * ny + cz * nz >= 0) idx.push(a, b, c);
  else idx.push(a, c, b);
}

function pushUp(idx: number[], pos: number[], a: number, b: number, c: number): void {
  pushFacing(idx, pos, a, b, c, 0, 1, 0);
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** White dome with glowing hibiscus-petal ribs. */
function petalMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xe8e4f0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vLocal;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uNight;\nvarying vec3 vLocal;\nvoid main() {')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float a = atan(vLocal.z, vLocal.x) / 6.2831853 * 9.0;
        float rib = 1.0 - smoothstep(0.0, 0.06, abs(fract(a) - 0.5) - 0.42);
        totalEmissiveRadiance += rib * vec3(1.0, 0.25, 0.6) * (0.3 + uNight * 2.0);`,
      );
  };
  return mat;
}

/** Low-detail towers outside the playable area so the horizon reads as a city. */
function skylineBuildings(map: MapData): MapBuilding[] {
  const b = map.bounds;
  const rand = mulberry32(4242);
  const out: MapBuilding[] = [];
  const pad = 140;
  for (let i = 0; i < 520; i++) {
    const x = b.minX - 1600 + rand() * (b.maxX - b.minX + 3200);
    const z = b.minZ - 1400 + rand() * (b.maxZ - b.minZ + 2800);
    if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad) continue;
    const w = 20 + rand() * 30, d = 18 + rand() * 25, a = rand() * 0.3;
    const ring: Vec2[] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(
      ([px, pz]) => [x + px * Math.cos(a) - pz * Math.sin(a), z + px * Math.sin(a) + pz * Math.cos(a)] as Vec2,
    );
    const kind = rand() < 0.45 ? 0 : 1;
    out.push({ p: ring.flat(), h: 30 + rand() * rand() * 170, k: kind });
  }
  return out;
}
