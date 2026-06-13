export class Input {
  private down = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      // Typing in a text field (e.g. the chat bar) must not steer the ship.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      this.down.add(e.code);
      // Keep Space/arrows from scrolling and Tab from moving focus.
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Touch controls: hold/release a synthetic key. */
  press(code: string) {
    this.down.add(code);
  }

  release(code: string) {
    this.down.delete(code);
  }
}
