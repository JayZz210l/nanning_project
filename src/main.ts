import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';
import { CollisionWorld } from './core/Collision';
import { centroid, toRing } from './core/geom';
import { Input } from './core/Input';
import type { MapData } from './core/types';
import { CameraRig } from './player/CameraRig';
import { FreeCamera } from './player/FreeCamera';
import { Player } from './player/Player';
import { Labels } from './ui/Labels';
import { Locator } from './ui/Locator';
import { Minimap } from './ui/Minimap';
import { City } from './world/City';
import { createSkyMaterial, shared } from './world/materials';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  loading: $('loading'),
  bar: $<HTMLDivElement>('loading-bar'),
  status: $('loading-status'),
  start: $('start'),
  startBtn: $<HTMLButtonElement>('start-btn'),
  hud: $('hud'),
  district: $('district'),
  place: $('place'),
  coords: $('coords'),
  fps: $('fps'),
  help: $('help'),
  minimap: $<HTMLCanvasElement>('minimap'),
  fullmap: $('fullmap'),
  fullmapCanvas: $<HTMLCanvasElement>('fullmap-canvas'),
  labels: $('labels'),
  speed: $('speed'),
  mode: $('mode'),
};

function progress(p: number, text: string): Promise<void> {
  ui.bar.style.width = `${Math.round(p * 100)}%`;
  ui.status.textContent = text;
  // yield so the browser can paint the loading screen between heavy steps
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function loadMap(): Promise<MapData> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/nanning.json`);
  if (!res.ok || !res.body) throw new Error(`地图数据加载失败 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 720_000;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    ui.bar.style.width = `${Math.min(55, (got / total) * 55)}%`;
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf)) as MapData;
}

/** Drops resolution and post-processing when the frame rate cannot keep up. */
class Quality {
  level = 2; // 2 high, 1 medium, 0 low
  private frames = 0;
  private time = 0;
  private slow = 0;
  fps = 60;

  constructor(private readonly apply: (level: number) => void) {
    apply(this.level);
  }

  tick(dt: number): void {
    this.frames++;
    this.time += dt;
    if (this.time < 1) return;
    this.fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    // hidden tabs / hitches produce outliers; require a few slow seconds in a row
    this.slow = this.fps < 48 ? this.slow + 1 : 0;
    if (this.slow >= 3 && this.level > 0) {
      this.level--;
      this.slow = 0;
      this.apply(this.level);
    }
  }

  cycle(): void {
    this.level = (this.level + 2) % 3;
    this.slow = 0;
    this.apply(this.level);
  }
}

async function main(): Promise<void> {
  await progress(0.02, '正在下载 OpenStreetMap 南宁地图数据…');
  const map = await loadMap();

  await progress(0.6, '正在生成道路、建筑与绿地…');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 6000);

  const city = new City(map);
  scene.add(city.group);

  await progress(0.85, '正在布置光照与天空…');
  const sunDir = new THREE.Vector3(0.5, 0.75, 0.35).normalize();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4500, 32, 16), createSkyMaterial(sunDir));
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.copy(sunDir).multiplyScalar(1000);
  scene.add(sun);
  const fog = new THREE.FogExp2(0x000000, 0.0006);
  scene.fog = fog;

  const collision = CollisionWorld.fromMap(map);
  const input = new Input(renderer.domElement);
  const player = new Player(collision);
  scene.add(player.object);
  const rig = new CameraRig(camera, collision);
  const free = new FreeCamera(camera, map.bounds);
  let freeMode = false;
  const locator = new Locator(map);
  const minimap = new Minimap(map, ui.minimap, ui.fullmapCanvas);
  const labels = new Labels(map.labels, ui.labels);

  // spawn on 民族大道 at 万象城 station, looking east down the boulevard toward the CBD
  const station = map.labels.find((l) => l.n.includes('万象城站'));
  const [sx, sz] = station ? [station.x, station.z] : [150, -405];
  player.teleport(sx, sz);
  rig.yaw = -Math.PI / 2 + 0.12;

  const teleports: Record<string, { pos: [number, number]; yaw: number }> = {};
  /** Finds a free standing spot `dist` meters from a landmark with a clear view of it. */
  const addViewpoint = (key: string, re: RegExp, dist: number, prefer: number, lookY: number) => {
    const a = map.buildings.find((x) => re.test(x.n ?? '')) ?? map.areas.find((x) => re.test(x.n ?? ''));
    if (!a) return;
    const [tx, tz] = centroid(toRing(a.p));
    for (let k = 0; k < 36; k++) {
      const ang = prefer + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 18);
      const px = tx + Math.cos(ang) * dist, pz = tz + Math.sin(ang) * dist;
      if (collision.isSolid(px, 1, pz)) continue;
      if (collision.castCamera(px, 1.7, pz, tx, lookY, tz, 2) < 0.75) continue;
      teleports[key] = { pos: [px, pz], yaw: Math.atan2(-(tx - px), -(tz - pz)) };
      return;
    }
  };
  teleports.Digit1 = { pos: [sx, sz], yaw: rig.yaw };
  addViewpoint('Digit2', /朱槿花厅/, 150, 0, 30);
  addViewpoint('Digit3', /^明湖$/, 75, 0, 2);
  addViewpoint('Digit4', /^三祺广场$/, 170, Math.PI / 4, 120);

  // ---------------------------------------------------------------- post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.7, 0.3, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const quality = new Quality((level) => {
    const dpr = window.devicePixelRatio || 1;
    const ratio = level === 2 ? Math.min(dpr, 1.5) : level === 1 ? Math.min(dpr, 1) : Math.min(dpr, 0.75);
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloom.enabled = level > 0;
    bloom.resolution.set(window.innerWidth / 2, window.innerHeight / 2);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------- day / night
  let nightTarget = 1;
  const nightColors = {
    fog: [new THREE.Color(0xb9cde0), new THREE.Color(0x1c0b2a)],
    hemiSky: [new THREE.Color(0xdfeeff), new THREE.Color(0x6668b0)],
    hemiGround: [new THREE.Color(0x8a8070), new THREE.Color(0x2a1838)],
  };
  const applyNight = (n: number) => {
    shared.uNight.value = n;
    fog.color.copy(nightColors.fog[0]).lerp(nightColors.fog[1], n);
    fog.density = THREE.MathUtils.lerp(0.00032, 0.00062, n);
    hemi.color.copy(nightColors.hemiSky[0]).lerp(nightColors.hemiSky[1], n);
    hemi.groundColor.copy(nightColors.hemiGround[0]).lerp(nightColors.hemiGround[1], n);
    hemi.intensity = THREE.MathUtils.lerp(1.7, 2.6, n);
    sun.intensity = THREE.MathUtils.lerp(2.1, 0.6, n);
    sun.color.set(n > 0.5 ? 0x9fa8ff : 0xfff1dd);
    bloom.strength = THREE.MathUtils.lerp(0.12, 0.55, n);
    bloom.threshold = THREE.MathUtils.lerp(1.0, 0.92, n);
    for (const o of city.group.children) if (o.userData.nightOnly) o.visible = n > 0.15;
  };
  applyNight(1);

  await progress(1, `已生成 ${map.buildings.length} 栋建筑 · ${map.roads.length} 条道路 · ${city.treeCount} 棵树`);
  renderer.compile(scene, camera);
  ui.loading.classList.add('hidden');
  ui.start.classList.remove('hidden');

  let started = false;
  const begin = () => {
    started = true;
    ui.start.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    input.requestLock();
  };
  ui.startBtn.addEventListener('click', begin);
  renderer.domElement.addEventListener('click', () => {
    if (started && !input.locked) input.requestLock();
  });
  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('unlocked', !input.locked);
  });

  const setFreeMode = (on: boolean) => {
    if (on === freeMode) return;
    freeMode = on;
    if (on) free.enter();
    else rig.yaw = free.yaw;
    ui.mode.classList.toggle('hidden', !on);
    document.body.classList.toggle('free-mode', on);
  };

  // debug hook for automated checks
  (window as unknown as { __game: unknown }).__game = { player, rig, free, quality, collision, renderer, map, scene, city, setFreeMode };

  const clock = new THREE.Clock();
  let locateTimer = 0;
  let elapsed = 0;
  const frame = () => {
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    shared.uTime.value = elapsed;

    if (input.hit('KeyT')) nightTarget = nightTarget > 0.5 ? 0 : 1;
    const n = shared.uNight.value;
    if (Math.abs(n - nightTarget) > 0.001) applyNight(n + Math.sign(nightTarget - n) * Math.min(Math.abs(nightTarget - n), dt * 0.7));
    if (input.hit('KeyH')) ui.help.classList.toggle('hidden');
    if (input.hit('KeyM')) {
      minimap.full = !minimap.full;
      ui.fullmap.classList.toggle('hidden', !minimap.full);
    }
    if (input.hit('KeyB')) quality.cycle();
    if (started && input.hit('KeyF')) setFreeMode(!freeMode);
    if (freeMode && input.hit('KeyG')) {
      // drop the character on the ground below the free camera
      player.teleport(camera.position.x, camera.position.z);
      setFreeMode(false);
    }
    for (const key of Object.keys(teleports)) {
      if (input.hit(key)) {
        const tp = teleports[key];
        setFreeMode(false);
        player.teleport(tp.pos[0], tp.pos[1]);
        rig.yaw = tp.yaw;
      }
    }

    if (freeMode) {
      free.update(dt, input);
    } else {
      if (started) player.update(dt, input, rig.yaw, elapsed);
      rig.update(dt, input, player.position);
    }
    sky.position.copy(camera.position);
    city.update(elapsed, shared.uNight.value);
    composer.render();

    labels.update(camera, started);
    quality.tick(dt);
    locateTimer -= dt;
    if (locateTimer <= 0 && started) {
      locateTimer = 0.25;
      const focus = freeMode ? camera.position : player.position;
      const loc = locator.locate(focus.x, focus.z);
      ui.district.textContent = loc.district;
      ui.place.textContent = loc.place;
      const o = map.meta.origin;
      const lat = o.lat - focus.z / 110574;
      const lon = o.lon + focus.x / (111320 * Math.cos((o.lat * Math.PI) / 180));
      ui.coords.textContent = `${lat.toFixed(5)}°N  ${lon.toFixed(5)}°E` + (freeMode ? `  ↑${focus.y.toFixed(0)} m` : '');
      ui.fps.textContent = `${Math.round(quality.fps)} FPS · ${['低', '中', '高'][quality.level]}画质`;
      ui.speed.textContent = freeMode
        ? `${(free.velocity.length() * 3.6).toFixed(0)} km/h · 巡航 ${free.speed.toFixed(0)} m/s`
        : `${(player.speed * 3.6).toFixed(0)} km/h`;
    }
    if (freeMode) minimap.update(camera.position.x, camera.position.z, free.facing, free.yaw);
    else if (started) minimap.update(player.position.x, player.position.z, player.facing, rig.yaw);
    input.endFrame();
  };
  renderer.setAnimationLoop(frame);
}

main().catch((err: Error) => {
  console.error(err);
  ui.status.textContent = `出错了：${err.message}`;
  ui.bar.style.background = '#ff3b6b';
});
