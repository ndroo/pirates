import type { Ship } from './ship';

const SPEED = 260; // px/s
const MAX_RANGE = 320; // px before the ball splashes into the sea

export class Cannonball {
  x: number;
  y: number;
  spent = false;
  readonly owner: Ship;

  private vx: number;
  private vy: number;
  private traveled = 0;

  constructor(x: number, y: number, direction: number, owner: Ship) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(direction) * SPEED;
    this.vy = Math.sin(direction) * SPEED;
    this.owner = owner;
  }

  update(dt: number) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.traveled += SPEED * dt;
    if (this.traveled >= MAX_RANGE) this.spent = true;
  }

  draw(ctx: CanvasRenderingContext2D) {
    drawCannonball(ctx, this.x, this.y);
  }
}

export function drawCannonball(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1b1b';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
