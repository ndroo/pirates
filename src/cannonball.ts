const SPEED = 260; // average px/s over the whole flight
const MAX_RANGE = 320; // px before the ball splashes into the sea
const FLIGHT_TIME = MAX_RANGE / SPEED; // s
const ARC_LIFT = 16; // px the ball climbs above its shadow at the apex

// Asymmetric ballistic feel: a hard launch, a slow hang at the apex, and a
// descent that only picks back up to roughly average speed — real shots
// don't slam into the water as fast as they left the muzzle. The speeds are
// multiples of the average; they must satisfy V_START + 2*V_APEX + V_END = 4
// so the ball still covers exactly MAX_RANGE in FLIGHT_TIME.
const V_START = 1.5;
const V_APEX = 0.7;
const V_END = 4 - V_START - 2 * V_APEX; // = 1.1

/** Fraction of the range covered at flight progress p, velocity-continuous. */
function easedProgress(p: number): number {
  const m1 = (V_START + V_APEX) / 2;
  const a1 = (V_START - V_APEX) / 2;
  const m2 = (V_END + V_APEX) / 2;
  const a2 = (V_END - V_APEX) / 2;
  if (p < 0.5) return m1 * p + (a1 * Math.sin(2 * Math.PI * p)) / (2 * Math.PI);
  return m1 * 0.5 + m2 * (p - 0.5) + (a2 * Math.sin(2 * Math.PI * p)) / (2 * Math.PI);
}

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
    const eased = easedProgress(this.p);
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
