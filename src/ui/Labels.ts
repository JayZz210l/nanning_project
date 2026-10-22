import * as THREE from 'three';
import type { MapLabel } from '../core/types';

/** HTML labels for landmarks projected into screen space each frame. */
export class Labels {
  private items: { label: MapLabel; el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
  private readonly v = new THREE.Vector3();

  constructor(labels: MapLabel[], private readonly container: HTMLElement) {
    for (const label of labels) {
      const el = document.createElement('div');
      el.className = `label label-${label.k}`;
      el.textContent = label.n;
      container.appendChild(el);
      this.items.push({ label, el, pos: new THREE.Vector3(label.x, label.y, label.z) });
    }
  }

  update(camera: THREE.PerspectiveCamera, visible: boolean): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const it of this.items) {
      const dist = camera.position.distanceTo(it.pos);
      const max = it.label.k === 'landmark' ? 2600 : it.label.k === 'water' ? 600 : 380;
      this.v.copy(it.pos).project(camera);
      const show = visible && this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && dist < max;
      if (!show) {
        if (it.el.style.display !== 'none') it.el.style.display = 'none';
        continue;
      }
      it.el.style.display = '';
      const x = (this.v.x * 0.5 + 0.5) * w, y = (-this.v.y * 0.5 + 0.5) * h;
      const fade = Math.min(1, (max - dist) / (max * 0.3));
      const scale = THREE.MathUtils.clamp(260 / Math.max(dist, 1), 0.7, 1.25);
      it.el.style.opacity = String(fade);
      it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
    }
  }
}
