const DURATION = 0.5; // s
const SPLASH_DURATION = 0.55; // s

/** A ring of white water where a cannonball (or fizzling barrel) lands. */
export class Splash {
  x: number;
  y: number;
  private age = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  get done(): boolean {
    return this.age >= SPLASH_DURATION;
  }

  update(dt: number) {
    this.age += dt;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const t = Math.min(this.age / SPLASH_DURATION, 1);
    ctx.save();

    // expanding foam ring
    ctx.beginPath();
    ctx.arc(this.x, this.y, 3 + 15 * t, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.75 * (1 - t)})`;
    ctx.lineWidth = 2.5 * (1 - t) + 0.5;
    ctx.stroke();

    // white plume that leaps up and falls back
    const leap = Math.sin(Math.PI * Math.min(t * 1.4, 1));
    ctx.beginPath();
    ctx.ellipse(this.x, this.y - leap * 8, 2.5, 2.5 + leap * 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(230, 243, 255, ${0.8 * (1 - t)})`;
    ctx.fill();

    ctx.restore();
  }
}

interface Spark {
  dx: number; // px/s
  dy: number;
}

export class Explosion {
  x: number;
  y: number;
  private age = 0;
  private sparks: Spark[] = [];

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 60;
      this.sparks.push({ dx: Math.cos(angle) * speed, dy: Math.sin(angle) * speed });
    }
  }

  get done(): boolean {
    return this.age >= DURATION;
  }

  update(dt: number) {
    this.age += dt;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const t = Math.min(this.age / DURATION, 1);
    ctx.save();
    ctx.globalAlpha = 1 - t;

    // Fireball: orange flash with a yellow core.
    ctx.beginPath();
    ctx.arc(this.x, this.y, 8 + 20 * t, 0, Math.PI * 2);
    ctx.fillStyle = '#e8742c';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.x, this.y, 4 + 8 * t, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd75e';
    ctx.fill();

    ctx.fillStyle = '#3a3a3a';
    for (const s of this.sparks) {
      ctx.beginPath();
      ctx.arc(this.x + s.dx * t, this.y + s.dy * t, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
