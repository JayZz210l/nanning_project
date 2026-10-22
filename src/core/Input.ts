/** Keyboard + pointer-lock mouse state. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    element.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  requestLock(): void {
    // Unadjusted movement avoids OS mouse acceleration where supported.
    // Pointer lock can be refused (embedded frames, rapid re-requests); the game still runs, the
    // player just clicks again, so rejections are swallowed.
    const el = this.element as HTMLElement & { requestPointerLock(o?: object): Promise<void> | void };
    const plain = () => {
      try {
        const r = el.requestPointerLock();
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        /* unsupported */
      }
    };
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r instanceof Promise) r.catch(plain);
    } catch {
      plain();
    }
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per physical key press. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
