import { decideTurn, wantsToFire } from './ai';
import { Cannonball, drawCannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import type { Net, NetMessage, ShipSnap } from './net';
import { Ship, SHIP_TYPES, type ShipTypeName, type Turn } from './ship';

// Fixed logical arena so both players see the same battlefield; the canvas is
// scaled to fit each window.
export const WORLD_W = 1280;
export const WORLD_H = 720;

const MAX_DT = 0.05; // s; clamp so tab-switch pauses don't teleport ships
const PLAYER_RELOAD = 1.4; // s between broadsides
const ENEMY_RELOAD = 2.2; // AI only; humans both get PLAYER_RELOAD

const HOST_COLOR = '#8b5a2b';
const GUEST_COLOR = '#7a1f1f';

export type GameMode =
  | { kind: 'solo' }
  | { kind: 'host'; net: Net }
  | { kind: 'guest'; net: Net };

const SELECT_KEYS: Record<string, ShipTypeName> = {
  Digit1: 'small',
  Digit2: 'medium',
  Digit3: 'large',
};

const SPEED_LABELS: Record<ShipTypeName, string> = {
  small: 'fast',
  medium: 'steady',
  large: 'slow',
};

interface Wave {
  x: number;
  y: number;
  r: number;
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private input: Input;
  private mode: GameMode;
  private net: Net | null = null;

  private phase: 'select' | 'battle' = 'select';
  private mine!: Ship; // this player's ship (the AI's in solo is `theirs`)
  private theirs!: Ship;
  private cannonballs: Cannonball[] = [];
  private explosions: Explosion[] = [];
  private waves: Wave[] = [];
  private lastTime = 0;

  // Multiplayer state.
  private myPick: ShipTypeName | null = null;
  private theirPick: ShipTypeName | null = null;
  private remoteInput = { turn: 0 as Turn, fire: false, restart: false }; // host: guest's keys
  private remoteBalls: { x: number; y: number }[] = []; // guest: balls from snapshots
  private pendingBoom: { x: number; y: number }[] = []; // host: explosions to send
  private disconnected = false;

  constructor(ctx: CanvasRenderingContext2D, input: Input, mode: GameMode = { kind: 'solo' }) {
    this.ctx = ctx;
    this.input = input;
    this.mode = mode;

    if (mode.kind !== 'solo') {
      this.net = mode.net;
      this.net.onMessage = (msg) => this.handleMessage(msg);
      this.net.onClose = () => {
        this.disconnected = true;
      };
    }

    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        r: 6 + Math.random() * 10,
      });
    }
  }

  private handleMessage(msg: NetMessage) {
    switch (msg.t) {
      case 'pick':
        this.theirPick = msg.ship;
        if (this.mode.kind === 'host') this.tryStartHostBattle();
        break;
      case 'input': // guest keys, applied by the host each frame
        this.remoteInput = { turn: msg.turn, fire: msg.fire, restart: msg.restart };
        break;
      case 'start': // host picked positions/types; guest mirrors them
        if (this.mode.kind === 'guest') {
          this.theirs = new Ship(WORLD_W * 0.3, WORLD_H * 0.6, -Math.PI / 4, HOST_COLOR, msg.hostType);
          this.mine = new Ship(WORLD_W * 0.7, WORLD_H * 0.3, Math.PI * 0.75, GUEST_COLOR, msg.guestType);
          this.cannonballs = [];
          this.remoteBalls = [];
          this.explosions = [];
          this.phase = 'battle';
        }
        break;
      case 'phase':
        this.resetToSelect();
        break;
      case 'state':
        if (this.mode.kind === 'guest' && this.phase === 'battle') {
          this.applySnap(this.theirs, msg.ships[0]);
          this.applySnap(this.mine, msg.ships[1]);
          this.remoteBalls = msg.balls;
          for (const b of msg.boom) this.explosions.push(new Explosion(b.x, b.y));
        }
        break;
    }
  }

  private applySnap(ship: Ship, snap: ShipSnap) {
    ship.x = snap.x;
    ship.y = snap.y;
    ship.heading = snap.heading;
    ship.health = snap.health;
    ship.sinkProgress = snap.sink;
  }

  private snapOf(ship: Ship): ShipSnap {
    return { x: ship.x, y: ship.y, heading: ship.heading, health: ship.health, sink: ship.sinkProgress };
  }

  private resetToSelect() {
    this.phase = 'select';
    this.myPick = null;
    this.theirPick = null;
    this.remoteInput = { turn: 0, fire: false, restart: false };
    this.cannonballs = [];
    this.remoteBalls = [];
    this.explosions = [];
    this.pendingBoom = [];
  }

  private startBattle(mineType: ShipTypeName, theirType: ShipTypeName) {
    this.mine = new Ship(WORLD_W * 0.3, WORLD_H * 0.6, -Math.PI / 4, HOST_COLOR, mineType);
    this.theirs = new Ship(WORLD_W * 0.7, WORLD_H * 0.3, Math.PI * 0.75, GUEST_COLOR, theirType);
    this.cannonballs = [];
    this.explosions = [];
    this.pendingBoom = [];
    this.phase = 'battle';
  }

  private tryStartHostBattle() {
    if (!this.myPick || !this.theirPick) return;
    this.startBattle(this.myPick, this.theirPick);
    this.net!.send({ t: 'start', hostType: this.myPick, guestType: this.theirPick });
  }

  private get over(): boolean {
    return !this.mine.alive || !this.theirs.alive;
  }

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min((now - this.lastTime) / 1000, MAX_DT);
    this.lastTime = now;
    this.update(dt);
    this.render();
    requestAnimationFrame(this.frame);
  };

  private update(dt: number) {
    if (this.disconnected) return;
    if (this.phase === 'select') {
      this.updateSelect();
      return;
    }

    let turn: Turn = 0;
    if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) turn = -1;
    if (this.input.isDown('ArrowRight') || this.input.isDown('KeyD')) turn = 1;

    if (this.mode.kind === 'guest') {
      this.net!.send({
        t: 'input',
        turn,
        fire: this.input.isDown('Space'),
        restart: this.over && this.input.isDown('KeyR'),
      });
      // The host simulates; we just animate our local explosion effects.
      for (const ex of this.explosions) ex.update(dt);
      this.explosions = this.explosions.filter((ex) => !ex.done);
      return;
    }

    if (this.over && (this.input.isDown('KeyR') || this.remoteInput.restart)) {
      this.resetToSelect();
      this.net?.send({ t: 'phase', phase: 'select' });
      return;
    }

    const theirTurn: Turn =
      this.mode.kind === 'host'
        ? this.remoteInput.turn
        : this.over
          ? 0
          : decideTurn(this.theirs, this.mine);

    this.mine.update(dt, turn, WORLD_W, WORLD_H);
    this.theirs.update(dt, theirTurn, WORLD_W, WORLD_H);

    if (!this.over) {
      if (this.input.isDown('Space') && this.mine.reload <= 0) {
        this.fireBroadside(this.mine, this.theirs, PLAYER_RELOAD);
      }
      const theirsFires =
        this.mode.kind === 'host'
          ? this.remoteInput.fire
          : wantsToFire(this.theirs, this.mine);
      if (theirsFires && this.theirs.reload <= 0) {
        this.fireBroadside(this.theirs, this.mine, this.mode.kind === 'host' ? PLAYER_RELOAD : ENEMY_RELOAD);
      }
    }

    for (const ball of this.cannonballs) {
      ball.update(dt);
      const target = ball.owner === this.mine ? this.theirs : this.mine;
      if (!ball.spent && target.alive && target.containsPoint(ball.x, ball.y)) {
        ball.spent = true;
        target.takeHit();
        this.explosions.push(new Explosion(ball.x, ball.y));
        this.pendingBoom.push({ x: ball.x, y: ball.y });
      }
    }
    this.cannonballs = this.cannonballs.filter((b) => !b.spent);

    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter((ex) => !ex.done);

    if (this.mode.kind === 'host') {
      this.net!.send({
        t: 'state',
        ships: [this.snapOf(this.mine), this.snapOf(this.theirs)],
        balls: this.cannonballs.map((b) => ({ x: b.x, y: b.y })),
        boom: this.pendingBoom,
      });
      this.pendingBoom = [];
    }
  }

  private updateSelect() {
    if (this.myPick) return;
    for (const [code, type] of Object.entries(SELECT_KEYS)) {
      if (!this.input.isDown(code)) continue;
      if (this.mode.kind === 'solo') {
        const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
        this.startBattle(type, types[Math.floor(Math.random() * types.length)]);
      } else {
        this.myPick = type;
        this.net!.send({ t: 'pick', ship: type });
        if (this.mode.kind === 'host') this.tryStartHostBattle();
      }
      break;
    }
  }

  /** Fire a volley from whichever side of the shooter faces the target. */
  private fireBroadside(shooter: Ship, target: Ship, reload: number) {
    const bearing = Math.atan2(target.y - shooter.y, target.x - shooter.x);
    const side = Math.sin(bearing - shooter.heading) >= 0 ? 1 : -1;
    const dir = shooter.heading + (side * Math.PI) / 2;

    const fx = Math.cos(shooter.heading);
    const fy = Math.sin(shooter.heading);
    const sx = Math.cos(dir);
    const sy = Math.sin(dir);

    for (let i = 0; i < shooter.guns; i++) {
      const along = (i / (shooter.guns - 1) - 0.5) * (shooter.length / 2);
      this.cannonballs.push(
        new Cannonball(
          shooter.x + fx * along + sx * (shooter.width / 2),
          shooter.y + fy * along + sy * (shooter.width / 2),
          dir,
          shooter,
        ),
      );
    }
    shooter.reload = reload;
  }

  private render() {
    this.drawSea();
    if (this.phase === 'select') {
      this.drawShipSelect();
    } else {
      const ctx = this.ctx;
      if (this.mode.kind === 'guest') {
        for (const ball of this.remoteBalls) drawCannonball(ctx, ball.x, ball.y);
      } else {
        for (const ball of this.cannonballs) ball.draw(ctx);
      }
      this.mine.draw(ctx);
      this.theirs.draw(ctx);
      for (const ex of this.explosions) ex.draw(ctx);

      const theirLabel = this.mode.kind === 'solo' ? 'Enemy' : 'Friend';
      this.drawHealthRow(`You (${this.mine.type})`, this.mine, 0);
      this.drawHealthRow(`${theirLabel} (${this.theirs.type})`, this.theirs, 1);

      if (this.over) this.drawGameOver();
    }

    if (this.disconnected) this.drawDisconnected();
  }

  private drawSea() {
    const ctx = this.ctx;

    ctx.fillStyle = '#1a4d7a';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    for (const wave of this.waves) {
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.r, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  }

  private drawShipSelect() {
    const ctx = this.ctx;
    const w = WORLD_W;
    const h = WORLD_H;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText('Pirates: Naval Combat', w / 2, h * 0.18);
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('Choose your ship', w / 2, h * 0.18 + 44);

    const color = this.mode.kind === 'guest' ? GUEST_COLOR : HOST_COLOR;
    const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
    types.forEach((type, i) => {
      const stats = SHIP_TYPES[type];
      const x = w / 2 + (i - 1) * 230;
      const y = h * 0.5;

      new Ship(x, y, -Math.PI / 2, color, type).draw(ctx);

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(`${i + 1} — ${type[0].toUpperCase()}${type.slice(1)}`, x, y + 70);
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(`${stats.guns} guns · ${SPEED_LABELS[type]} · ${stats.maxHealth} hits to sink`, x, y + 94);
    });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '17px system-ui, sans-serif';
    if (this.mode.kind === 'solo') {
      ctx.fillText('Press 1, 2 or 3 to set sail — the enemy ship is chosen at random', w / 2, h * 0.82);
    } else if (this.myPick) {
      ctx.fillText(`You chose the ${this.myPick} ship — waiting for your friend…`, w / 2, h * 0.82);
    } else {
      ctx.fillText('Press 1, 2 or 3 to choose your ship', w / 2, h * 0.82);
      ctx.fillText(
        this.theirPick ? 'Your friend is ready!' : 'Your friend is still choosing…',
        w / 2,
        h * 0.82 + 28,
      );
    }
  }

  private drawHealthRow(label: string, ship: Ship, row: number) {
    const ctx = this.ctx;
    const segW = 14;
    const segH = 10;
    const gap = 3;
    const margin = 16;

    const y = margin + row * (segH + 12);
    const totalW = ship.maxHealth * (segW + gap) - gap;
    const x0 = WORLD_W - margin - totalW;

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x0 - 10, y + segH / 2);

    for (let i = 0; i < ship.maxHealth; i++) {
      ctx.fillStyle = i < ship.health ? '#4caf50' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
    }
  }

  private drawGameOver() {
    const ctx = this.ctx;
    const w = WORLD_W;
    const h = WORLD_H;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 42px system-ui, sans-serif';
    const won = this.mine.alive;
    const title =
      this.mode.kind === 'solo'
        ? won
          ? 'Enemy ship destroyed!'
          : 'Your ship was destroyed!'
        : won
          ? 'Victory! You sank your friend!'
          : 'Your ship was destroyed!';
    ctx.fillText(title, w / 2, h / 2 - 20);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText(this.mode.kind === 'solo' ? 'Press R for a new battle' : 'Press R for a rematch', w / 2, h / 2 + 24);
  }

  private drawDisconnected() {
    const ctx = this.ctx;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText('Connection lost', WORLD_W / 2, WORLD_H / 2 - 18);
    ctx.font = '19px system-ui, sans-serif';
    ctx.fillText('Refresh the page to start a new game.', WORLD_W / 2, WORLD_H / 2 + 22);
  }
}
