export class Input {
  private down = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      this.down.add(e.code);
      // Keep Space/arrows from scrolling the page.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
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
