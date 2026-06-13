const SPEED = 260; // average px/s over the whole flight
const MAX_RANGE = 320; // px before the ball splashes into the sea
const FLIGHT_TIME = MAX_RANGE / SPEED; // s
// Ballistic feel: ground speed surges at launch and impact and sags through
// the apex — ±45% around the average, total flight time unchanged.
const SURGE = 0.45;
const ARC_LIFT = 16; // px the ball climbs above its shadow at the apex

export class Cannonball {
  x: number; // ground position (the shadow) — used for hit detection
  y: number;
  p = 0; // 0 = muzzle, 1 = splash
  spent = false;
  // Player slot id, not a Ship: the shooter may sink and respawn as a new
  // Ship while this ball is still in flight.
  readonly ownerId: number;

  private startX: number;
  private startY: number;
  private dirX: number;
  private dirY: number;

  constructor(x: number, y: number, direction: number, ownerId: number) {
    this.x = x;
    this.y = y;
    this.startX = x;
    this.startY = y;
    this.dirX = Math.cos(direction);
    this.dirY = Math.sin(direction);
    this.ownerId = ownerId;
  }

  update(dt: number) {
    this.p = Math.min(1, this.p + dt / FLIGHT_TIME);
    const eased = this.p + (SURGE * Math.sin(2 * Math.PI * this.p)) / (2 * Math.PI);
    this.x = this.startX + this.dirX * MAX_RANGE * eased;
    this.y = this.startY + this.dirY * MAX_RANGE * eased;
    if (this.p >= 1) this.spent = true;
  }

  draw(ctx: CanvasRenderingContext2D) {
    drawCannonball(ctx, this.x, this.y, this.p);
  }
}

export function drawCannonball(ctx: CanvasRenderingContext2D, x: number, y: number, p = 0) {
  const lift = Math.sin(Math.PI * p);

  // Shadow on the water, fading as the ball climbs away from it.
  ctx.beginPath();
  ctx.ellipse(x, y, 3.5, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.3 - lift * 0.18})`;
  ctx.fill();

  // The ball itself: lifted and enlarged at the top of its arc.
  ctx.beginPath();
  ctx.arc(x, y - lift * ARC_LIFT, 3 + lift * 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1b1b';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
