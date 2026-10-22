import { toRing } from '../core/geom';
import type { MapData } from '../core/types';

const SCALE = 0.5; // pixels per meter in the pre-rendered map

const FILL: Record<string, string> = {
  water: '#1f6f9a', park: '#24553a', forest: '#1c4630', grass: '#2b5e3a', pitch: '#2c6b4a',
  plaza: '#3c3846', parking: '#2a2a33', residential: '#24242e', commercial: '#2b2534', civic: '#2c2a2a',
  construction: '#3a3226',
};

/** North-up minimap rendered once to an offscreen canvas, then cropped around the player. */
export class Minimap {
  private readonly base: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly fullCtx: CanvasRenderingContext2D;
  private readonly size: number;
  full = false;

  constructor(private readonly map: MapData, canvas: HTMLCanvasElement, private readonly fullCanvas: HTMLCanvasElement) {
    const b = map.bounds;
    this.base = document.createElement('canvas');
    this.base.width = Math.ceil((b.maxX - b.minX) * SCALE);
    this.base.height = Math.ceil((b.maxZ - b.minZ) * SCALE);
    this.draw();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = canvas.clientWidth || 190;
    canvas.width = canvas.height = this.size * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.fullCtx = fullCanvas.getContext('2d')!;
  }

  private draw(): void {
    const g = this.base.getContext('2d')!;
    const b = this.map.bounds;
    const tx = (x: number) => (x - b.minX) * SCALE;
    const tz = (z: number) => (z - b.minZ) * SCALE;
    g.fillStyle = '#14141c';
    g.fillRect(0, 0, this.base.width, this.base.height);
    const path = (flat: number[]) => {
      const r = toRing(flat);
      g.moveTo(tx(r[0][0]), tz(r[0][1]));
      for (let i = 1; i < r.length; i++) g.lineTo(tx(r[i][0]), tz(r[i][1]));
    };
    for (const a of this.map.areas) {
      g.beginPath();
      path(a.p);
      g.closePath();
      for (const h of a.h ?? []) { path(h); g.closePath(); }
      g.fillStyle = FILL[a.k] ?? '#222';
      g.fill('evenodd');
    }
    const roadColor = ['#e9a23b', '#d8d0c0', '#9d97a8', '#6f6a7a', '#7a4a6a'];
    for (let c = 4; c >= 0; c--) {
      g.strokeStyle = roadColor[c];
      g.lineCap = g.lineJoin = 'round';
      for (const r of this.map.roads) {
        if (r.c !== c) continue;
        g.lineWidth = Math.max(1, r.w * SCALE * (c === 4 ? 0.7 : 1));
        g.beginPath();
        path(r.p);
        g.stroke();
      }
    }
    for (const bl of this.map.buildings) {
      g.beginPath();
      path(bl.p);
      g.closePath();
      g.fillStyle = bl.h > 150 ? '#ff4fb4' : bl.k === 0 ? '#3d87b8' : bl.k === 1 ? '#6b6680' : '#7a6f66';
      g.fill();
    }
    g.font = 'bold 22px "Microsoft YaHei", "PingFang SC", sans-serif';
    g.textAlign = 'center';
    for (const l of this.map.labels) {
      if (l.k === 'metro') continue;
      g.fillStyle = l.k === 'water' ? '#8fd8ff' : '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 4;
      const name = l.n.split(' · ')[0];
      g.strokeText(name, tx(l.x), tz(l.z));
      g.fillText(name, tx(l.x), tz(l.z));
    }
  }

  /** @param heading camera yaw (radians), used for the view cone */
  update(px: number, pz: number, facing: number, heading: number): void {
    const b = this.map.bounds;
    const g = this.ctx, s = this.size;
    const view = 420; // meters shown across
    const k = s / view;
    g.save();
    g.clearRect(0, 0, s, s);
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0d0d14';
    g.fillRect(0, 0, s, s);
    const sx = (px - b.minX - view / 2) * SCALE, sz = (pz - b.minZ - view / 2) * SCALE;
    g.drawImage(this.base, sx, sz, view * SCALE, view * SCALE, 0, 0, s, s);
    // view cone
    g.translate(s / 2, s / 2);
    g.fillStyle = 'rgba(80,220,255,0.18)';
    g.beginPath();
    g.moveTo(0, 0);
    const fwd = Math.atan2(-Math.cos(heading), -Math.sin(heading));
    g.arc(0, 0, 70 * k * 1.5, fwd - 0.6, fwd + 0.6);
    g.closePath();
    g.fill();
    this.arrow(g, facing, 1);
    g.restore();
    if (this.full) this.drawFull(px, pz, facing);
  }

  private arrow(g: CanvasRenderingContext2D, facing: number, scale: number): void {
    g.save();
    g.rotate(-facing + Math.PI);
    g.scale(scale, scale);
    g.fillStyle = '#4ff0ff';
    g.strokeStyle = '#001';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6, 7);
    g.lineTo(0, 3);
    g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  private drawFull(px: number, pz: number, facing: number): void {
    const c = this.fullCanvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = this.fullCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = Math.min(w / this.base.width, h / this.base.height);
    const ox = (w - this.base.width * k) / 2, oy = (h - this.base.height * k) / 2;
    g.clearRect(0, 0, w, h);
    g.drawImage(this.base, ox, oy, this.base.width * k, this.base.height * k);
    const b = this.map.bounds;
    g.save();
    g.translate(ox + (px - b.minX) * SCALE * k, oy + (pz - b.minZ) * SCALE * k);
    this.arrow(g, facing, 1.4);
    g.restore();
  }
}
