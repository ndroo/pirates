export type Turn = -1 | 0 | 1;

export interface ShipStats {
  speed: number; // px/s
  turnRate: number; // rad/s
  maxHealth: number; // cannonball hits to sink
  guns: number; // cannonballs per broadside
  length: number; // px
  width: number; // px
}

// Small ships are fast but fragile; large ships are slow but tough.
export const SHIP_TYPES = {
  small: { speed: 110, turnRate: 1.6, maxHealth: 3, guns: 2, length: 42, width: 17 },
  medium: { speed: 80, turnRate: 1.2, maxHealth: 5, guns: 3, length: 56, width: 22 },
  large: { speed: 55, turnRate: 0.9, maxHealth: 8, guns: 4, length: 72, width: 28 },
} as const satisfies Record<string, ShipStats>;

export type ShipTypeName = keyof typeof SHIP_TYPES;

const SINK_DURATION = 1.5; // s to fade out after health hits 0

const SAIL_FRESH = { r: 243, g: 234, b: 215 }; // #f3ead7
const SAIL_RAGGED = { r: 169, g: 152, b: 120 }; // dirty, battle-worn canvas

/** Cheap deterministic pseudo-random in [0, 1) — stable per (seed, n). */
function jitter(seed: number, n: number): number {
  const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

export class Ship {
  x: number;
  y: number;
  heading: number; // radians, 0 = pointing right (+x)
  speed: number;
  turnRate: number;
  maxHealth: number;
  health: number;
  guns: number;
  reload = 0; // s until cannons are ready again
  sinkProgress = 0; // 0 afloat → 1 fully sunk

  readonly type: ShipTypeName;
  readonly length: number;
  readonly width: number;

  private hullColor: string;
  // Seeds this ship's damage pattern (scorch spots, sail tears) so it stays
  // put frame to frame. Cosmetic only, so peers needn't agree on it.
  private scarSeed = Math.random() * 1000;

  constructor(x: number, y: number, heading: number, hullColor: string, type: ShipTypeName) {
    const stats = SHIP_TYPES[type];
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.hullColor = hullColor;
    this.type = type;
    this.speed = stats.speed;
    this.turnRate = stats.turnRate;
    this.maxHealth = stats.maxHealth;
    this.health = stats.maxHealth;
    this.guns = stats.guns;
    this.length = stats.length;
    this.width = stats.width;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  takeHit() {
    this.health = Math.max(0, this.health - 1);
  }

  update(dt: number, turn: Turn, worldW: number, worldH: number) {
    this.reload = Math.max(0, this.reload - dt);

    if (!this.alive) {
      this.sinkProgress = Math.min(1, this.sinkProgress + dt / SINK_DURATION);
      return;
    }

    this.heading += turn * this.turnRate * dt;
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // Wrap around world edges, with margin so the ship fully leaves first.
    const m = this.length;
    if (this.x < -m) this.x = worldW + m;
    if (this.x > worldW + m) this.x = -m;
    if (this.y < -m) this.y = worldH + m;
    if (this.y > worldH + m) this.y = -m;
  }

  /** Is the point inside this ship's oriented bounding box? */
  containsPoint(px: number, py: number): boolean {
    const dx = px - this.x;
    const dy = py - this.y;
    const cos = Math.cos(-this.heading);
    const sin = Math.sin(-this.heading);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.abs(localX) <= this.length / 2 && Math.abs(localY) <= this.width / 2;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.sinkProgress >= 1) return;

    const damage = 1 - this.health / this.maxHealth;
    const fade = 1 - this.sinkProgress;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.heading);

    const l = this.length;
    const w = this.width;

    // Hull: pointed bow (+x), flat stern.
    ctx.beginPath();
    ctx.moveTo(l / 2, 0);
    ctx.quadraticCurveTo(l / 6, -w / 2, -l / 2, -w / 2.6);
    ctx.lineTo(-l / 2, w / 2.6);
    ctx.quadraticCurveTo(l / 6, w / 2, l / 2, 0);
    ctx.closePath();
    ctx.fillStyle = this.hullColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Deck line.
    ctx.beginPath();
    ctx.moveTo(l / 2 - 6, 0);
    ctx.lineTo(-l / 2 + 4, 0);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Battle scars: scorch blotches accumulate on the deck as health drops.
    const blotches = Math.round(damage * 4);
    for (let i = 0; i < blotches; i++) {
      const u = jitter(this.scarSeed, i * 2);
      const v = jitter(this.scarSeed, i * 2 + 1);
      ctx.beginPath();
      ctx.ellipse(
        (u - 0.5) * l * 0.7,
        (v - 0.5) * w * 0.55,
        3 + u * 3,
        2 + v * 2,
        u * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = 'rgba(22, 14, 8, 0.6)';
      ctx.fill();
    }

    // Square sails: two masts, sails set across the hull. They dirty, shrink
    // and tatter as the ship takes hits.
    const mix = (a: number, b: number) => Math.round(a + (b - a) * damage);
    ctx.fillStyle = `rgb(${mix(SAIL_FRESH.r, SAIL_RAGGED.r)}, ${mix(SAIL_FRESH.g, SAIL_RAGGED.g)}, ${mix(SAIL_FRESH.b, SAIL_RAGGED.b)})`;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    [l / 6, -l / 5].forEach((mastX, m) => {
      const span = w * 1.5 * (1 - damage * 0.35);
      const segs = 6;
      ctx.beginPath();
      for (let k = 0; k <= segs; k++) {
        // Right edge, bow side: tears bite deeper the more damage there is.
        const tear = k === 0 || k === segs ? 0 : damage * 4.5 * jitter(this.scarSeed + m * 31, k);
        const py = -span / 2 + (span * k) / segs;
        const px = mastX + 3 - tear;
        k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      for (let k = segs; k >= 0; k--) {
        const tear = k === 0 || k === segs ? 0 : damage * 4.5 * jitter(this.scarSeed + m * 31 + 57, k);
        const py = -span / 2 + (span * k) / segs;
        ctx.lineTo(mastX - 3 + tear, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    ctx.restore();

    // Smoke billows once the ship is badly hurt — drawn in world space so it
    // drifts the same way whatever the heading.
    if (damage >= 0.45 && this.health > 0) {
      const t = performance.now() / 1000;
      const puffs = damage >= 0.75 ? 4 : 2;
      ctx.save();
      for (let i = 0; i < puffs; i++) {
        const phase = (t * 0.55 + i / puffs + jitter(this.scarSeed, i + 9)) % 1;
        const px = this.x + Math.sin(t * 1.4 + i * 2.6 + this.scarSeed) * 4 + (i - puffs / 2) * 3;
        const py = this.y - 6 - phase * 26;
        ctx.beginPath();
        ctx.arc(px, py, 2.5 + phase * 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(60, 60, 60, ${(1 - phase) * 0.4 * fade})`;
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
