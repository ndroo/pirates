import { decideTurn, wantsToFire } from './ai';
import { Cannonball, drawCannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import type { BattleMode, GuestNet, HostNet, NetMessage, ShipSnap } from './net';
import { Ship, SHIP_TYPES, type ShipTypeName, type Turn } from './ship';

// Fixed logical arena so all players see the same battlefield; the canvas is
// scaled to fit each window.
export const WORLD_W = 1280;
export const WORLD_H = 720;

const MAX_DT = 0.05; // s; clamp so tab-switch pauses don't teleport ships
const PLAYER_RELOAD = 1.4; // s between broadsides
const AI_RELOAD = 2.2; // the AI aims perfectly, so it reloads slower
const RESPAWN_DELAY = 3; // s between fully sinking and reappearing
const SINK_TARGET = 5; // respawn mode: sinks needed to win the round

// One distinct hull color per player slot (host is 0).
export const PLAYER_COLORS = [
  '#8b5a2b', '#7a1f1f', '#1f5c7a', '#3f7a26', '#6b3fa0', '#a07a1f', '#a0421f', '#3fa08c',
  '#535ec8', '#b3477e', '#5a7a1f', '#1f7a5c', '#8c5ab0', '#b08c2a', '#6e6e6e', '#274fa0',
];

export type GameMode =
  | { kind: 'solo' }
  | { kind: 'host'; net: HostNet; battle: BattleMode }
  | { kind: 'guest'; net: GuestNet };

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

/** One player (or the solo AI) in the match. */
interface Slot {
  id: number; // 0 = host; shown as "Player <id + 1>"
  color: string;
  ai: boolean;
  pick: ShipTypeName | null;
  ship: Ship | null;
  input: { turn: Turn; fire: boolean; restart: boolean }; // latest remote keys
  score: number; // ships sunk (respawn mode)
  respawnIn: number | null; // s until respawn, once fully sunk
  left: boolean; // disconnected mid-battle; never respawns
}

function newSlot(id: number, ai = false): Slot {
  return {
    id,
    color: PLAYER_COLORS[id % PLAYER_COLORS.length],
    ai,
    pick: null,
    ship: null,
    input: { turn: 0, fire: false, restart: false },
    score: 0,
    respawnIn: null,
    left: false,
  };
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private input: Input;
  private mode: GameMode;

  private phase: 'select' | 'battle' = 'select';
  private battleMode: BattleMode = 'elimination';
  private target = SINK_TARGET; // respawn mode: sinks needed to win
  private slots: Slot[] = [];
  private selfId: number;
  private myPick: ShipTypeName | null = null;
  private cannonballs: Cannonball[] = [];
  private explosions: Explosion[] = [];
  private waves: Wave[] = [];
  private lastTime = 0;

  // Multiplayer state.
  private remoteBalls: { x: number; y: number }[] = []; // guest: balls from snapshots
  private pendingBoom: { x: number; y: number }[] = []; // host: explosions to send
  private readyInfo: { ready: number; total: number } | null = null; // guest: select progress
  private disconnected = false;

  constructor(ctx: CanvasRenderingContext2D, input: Input, mode: GameMode = { kind: 'solo' }) {
    this.ctx = ctx;
    this.input = input;
    this.mode = mode;
    this.selfId = mode.kind === 'guest' ? mode.net.selfId : 0;

    if (mode.kind === 'host') {
      this.battleMode = mode.battle;
      mode.net.onMessage = (id, msg) => this.handleGuestMessage(id, msg);
      mode.net.onGuestLeave = (id) => this.dropPlayer(id);
    } else if (mode.kind === 'guest') {
      mode.net.onMessage = (msg) => this.handleHostMessage(msg);
      mode.net.onClose = () => {
        this.disconnected = true;
      };
    }
    this.buildSlots();

    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        r: 6 + Math.random() * 10,
      });
    }
  }

  /** Roster for the next battle. Guests get theirs from the start message. */
  private buildSlots() {
    if (this.mode.kind === 'solo') {
      this.slots = [newSlot(0), newSlot(1, true)];
    } else if (this.mode.kind === 'host') {
      this.slots = [newSlot(0), ...this.mode.net.guestIds.map((id) => newSlot(id))];
    } else {
      this.slots = [];
    }
  }

  private get selfSlot(): Slot | undefined {
    return this.slots.find((s) => s.id === this.selfId);
  }

  private get aliveSlots(): Slot[] {
    return this.slots.filter((s) => s.ship?.alive);
  }

  private get over(): boolean {
    if (this.phase !== 'battle') return false;
    if (this.battleMode === 'respawn') return this.slots.some((s) => s.score >= this.target);
    return this.aliveSlots.length <= 1;
  }

  private get winner(): Slot | undefined {
    if (!this.over) return undefined;
    if (this.battleMode === 'respawn') return this.slots.find((s) => s.score >= this.target);
    return this.aliveSlots[0];
  }

  // --- messages ---

  private handleGuestMessage(id: number, msg: NetMessage) {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) return;
    if (msg.t === 'pick' && this.phase === 'select' && !slot.pick) {
      slot.pick = msg.ship;
      this.broadcastPicked();
      this.maybeStartBattle();
    } else if (msg.t === 'input') {
      slot.input = { turn: msg.turn, fire: msg.fire, restart: msg.restart };
    }
  }

  private handleHostMessage(msg: NetMessage) {
    switch (msg.t) {
      case 'go-select':
        this.resetToSelect();
        break;
      case 'picked':
        this.readyInfo = { ready: msg.ready, total: msg.total };
        break;
      case 'start':
        this.battleMode = msg.mode;
        this.target = msg.target;
        this.slots = msg.ships.map((sp) => {
          const slot = newSlot(sp.id);
          slot.pick = sp.type;
          slot.ship = new Ship(sp.x, sp.y, sp.heading, slot.color, sp.type);
          return slot;
        });
        this.cannonballs = [];
        this.remoteBalls = [];
        this.explosions = [];
        this.phase = 'battle';
        break;
      case 'state':
        if (this.phase !== 'battle') break;
        for (const snap of msg.ships) this.applySnap(snap);
        this.remoteBalls = msg.balls;
        for (const b of msg.boom) this.explosions.push(new Explosion(b.x, b.y));
        break;
    }
  }

  private applySnap(snap: ShipSnap) {
    const slot = this.slots.find((s) => s.id === snap.id);
    if (!slot?.ship) return;
    slot.score = snap.score;
    const ship = slot.ship;
    ship.x = snap.x;
    ship.y = snap.y;
    ship.heading = snap.heading;
    ship.health = snap.health;
    ship.sinkProgress = snap.sink;
  }

  /** Host: a guest's connection dropped. */
  private dropPlayer(id: number) {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) return;
    if (this.phase === 'select') {
      this.slots = this.slots.filter((s) => s !== slot);
      this.broadcastPicked();
      this.maybeStartBattle();
    } else {
      slot.left = true;
      if (slot.ship) slot.ship.health = 0; // their ship sinks where it sailed
    }
  }

  private resetToSelect() {
    this.phase = 'select';
    this.myPick = null;
    this.readyInfo = null;
    this.cannonballs = [];
    this.remoteBalls = [];
    this.explosions = [];
    this.pendingBoom = [];
    this.buildSlots();
    if (this.mode.kind === 'host') {
      this.mode.net.broadcast({ t: 'go-select' });
      this.broadcastPicked();
    }
  }

  private broadcastPicked() {
    if (this.mode.kind !== 'host' || this.phase !== 'select') return;
    const ready = this.slots.filter((s) => s.pick).length;
    this.mode.net.broadcast({ t: 'picked', ready, total: this.slots.length });
  }

  // --- battle setup ---

  /** (Re)place a slot's ship on the spawn ring at the given angle. */
  private spawnShip(slot: Slot, angle: number) {
    slot.ship = new Ship(
      WORLD_W / 2 + Math.cos(angle) * WORLD_W * 0.32,
      WORLD_H / 2 + Math.sin(angle) * WORLD_H * 0.32,
      angle + Math.PI / 2, // tangent to the ring
      slot.color,
      slot.pick!,
    );
    slot.respawnIn = null;
  }

  /** Host/solo: once everyone has picked, spawn the fleet in a ring and go. */
  private maybeStartBattle() {
    if (this.phase !== 'select' || this.slots.some((s) => !s.pick)) return;

    const n = this.slots.length;
    this.slots.forEach((slot, i) => {
      this.spawnShip(slot, (i / n) * Math.PI * 2 - Math.PI / 2);
    });
    this.cannonballs = [];
    this.explosions = [];
    this.pendingBoom = [];
    this.phase = 'battle';

    if (this.mode.kind === 'host') {
      this.mode.net.broadcast({
        t: 'start',
        mode: this.battleMode,
        target: this.target,
        ships: this.slots.map((s) => ({
          id: s.id,
          type: s.pick!,
          x: s.ship!.x,
          y: s.ship!.y,
          heading: s.ship!.heading,
        })),
      });
    }
  }

  private nearestEnemy(ship: Ship): Ship | null {
    let best: Ship | null = null;
    let bestDist = Infinity;
    for (const slot of this.slots) {
      const other = slot.ship;
      if (!other || other === ship || !other.alive) continue;
      const d = Math.hypot(other.x - ship.x, other.y - ship.y);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  // --- game loop ---

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
      this.mode.net.send({
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

    if (this.over && (this.input.isDown('KeyR') || this.slots.some((s) => s.input.restart))) {
      this.resetToSelect();
      return;
    }

    for (const slot of this.slots) {
      const ship = slot.ship;
      if (!ship) continue;

      // Respawn mode: a fully sunk ship reappears after a short delay.
      if (this.battleMode === 'respawn' && !ship.alive && !slot.left && !this.over && ship.sinkProgress >= 1) {
        slot.respawnIn ??= RESPAWN_DELAY;
        slot.respawnIn -= dt;
        if (slot.respawnIn <= 0) this.spawnShip(slot, Math.random() * Math.PI * 2);
        continue;
      }

      let shipTurn: Turn = 0;
      let fire = false;
      if (slot.id === this.selfId) {
        shipTurn = turn;
        fire = this.input.isDown('Space');
      } else if (slot.ai) {
        const target = this.nearestEnemy(ship);
        shipTurn = !this.over && target ? decideTurn(ship, target) : 0;
        fire = !this.over && target ? wantsToFire(ship, target) : false;
      } else {
        shipTurn = slot.input.turn;
        fire = slot.input.fire;
      }

      ship.update(dt, shipTurn, WORLD_W, WORLD_H);

      if (!this.over && fire && ship.alive && ship.reload <= 0) {
        const target = this.nearestEnemy(ship);
        if (target) this.fireBroadside(slot, target);
      }
    }

    for (const ball of this.cannonballs) {
      ball.update(dt);
      if (ball.spent) continue;
      for (const slot of this.slots) {
        const target = slot.ship;
        if (!target || slot.id === ball.ownerId || !target.alive) continue;
        if (target.containsPoint(ball.x, ball.y)) {
          ball.spent = true;
          target.takeHit();
          if (!target.alive) {
            const shooter = this.slots.find((s) => s.id === ball.ownerId);
            if (shooter) shooter.score++;
          }
          this.explosions.push(new Explosion(ball.x, ball.y));
          this.pendingBoom.push({ x: ball.x, y: ball.y });
          break;
        }
      }
    }
    this.cannonballs = this.cannonballs.filter((b) => !b.spent);

    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter((ex) => !ex.done);

    if (this.mode.kind === 'host') {
      this.mode.net.broadcast({
        t: 'state',
        ships: this.slots.filter((s) => s.ship).map((s) => ({
          id: s.id,
          x: s.ship!.x,
          y: s.ship!.y,
          heading: s.ship!.heading,
          health: s.ship!.health,
          sink: s.ship!.sinkProgress,
          score: s.score,
        })),
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
      this.myPick = type;
      if (this.mode.kind === 'guest') {
        this.mode.net.send({ t: 'pick', ship: type });
      } else {
        const self = this.selfSlot;
        if (self) self.pick = type;
        if (this.mode.kind === 'solo') {
          const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
          this.slots.find((s) => s.ai)!.pick = types[Math.floor(Math.random() * types.length)];
        }
        this.broadcastPicked();
        this.maybeStartBattle();
      }
      break;
    }
  }

  /** Fire a volley from whichever side of the shooter faces the target. */
  private fireBroadside(shooterSlot: Slot, target: Ship) {
    const shooter = shooterSlot.ship!;
    const reload = shooterSlot.ai ? AI_RELOAD : PLAYER_RELOAD;
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
          shooterSlot.id,
        ),
      );
    }
    shooter.reload = reload;
  }

  // --- rendering ---

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
      for (const slot of this.slots) slot.ship?.draw(ctx);
      for (const slot of this.slots) this.drawShipTag(slot);
      for (const ex of this.explosions) ex.draw(ctx);

      this.slots.forEach((slot, row) => {
        if (slot.ship) this.drawHealthRow(slot, row);
      });

      this.drawRespawnNotice();
      if (this.over) this.drawGameOver();
    }

    if (this.disconnected) this.drawDisconnected();
  }

  private slotLabel(slot: Slot): string {
    if (slot.id === this.selfId) return 'You';
    if (slot.ai) return 'Enemy';
    return `Player ${slot.id + 1}`;
  }

  /** Small name tag above each afloat ship so players can find themselves. */
  private drawShipTag(slot: Slot) {
    const ship = slot.ship;
    if (!ship || !ship.alive || this.slots.length <= 2) return;
    const ctx = this.ctx;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = slot.id === this.selfId ? '#fff' : 'rgba(255, 255, 255, 0.65)';
    ctx.fillText(slot.id === this.selfId ? 'You' : `P${slot.id + 1}`, ship.x, ship.y - ship.length / 2 - 8);
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

    const color = PLAYER_COLORS[this.selfId % PLAYER_COLORS.length];
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
      return;
    }

    ctx.fillText(
      this.myPick
        ? `You chose the ${this.myPick} ship — waiting for the other captains…`
        : 'Press 1, 2 or 3 to choose your ship',
      w / 2,
      h * 0.82,
    );
    const ready =
      this.mode.kind === 'host'
        ? { ready: this.slots.filter((s) => s.pick).length, total: this.slots.length }
        : this.readyInfo;
    if (ready) {
      ctx.fillText(`${ready.ready}/${ready.total} captains ready`, w / 2, h * 0.82 + 28);
    }
  }

  private drawHealthRow(slot: Slot, row: number) {
    const ctx = this.ctx;
    const ship = slot.ship!;
    const segW = 14;
    const segH = 10;
    const gap = 3;
    const margin = 16;

    const y = margin + row * (segH + 12);
    const totalW = ship.maxHealth * (segW + gap) - gap;
    const x0 = WORLD_W - margin - totalW;

    ctx.fillStyle = slot.color;
    ctx.fillRect(x0 - 18, y, segH, segH);

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const score = this.battleMode === 'respawn' ? ` · ${slot.score} sunk` : '';
    ctx.fillText(`${this.slotLabel(slot)} (${ship.type})${score}`, x0 - 26, y + segH / 2);

    for (let i = 0; i < ship.maxHealth; i++) {
      ctx.fillStyle = i < ship.health ? '#4caf50' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
    }
  }

  /** Respawn mode: tell a sunk player their ship is coming back. */
  private drawRespawnNotice() {
    const self = this.selfSlot;
    if (
      this.battleMode !== 'respawn' ||
      this.over ||
      !self?.ship ||
      self.ship.alive ||
      self.ship.sinkProgress < 1
    ) {
      return;
    }
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText('You sank — respawning…', WORLD_W / 2, WORLD_H / 2);
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

    const winner = this.winner;
    let title: string;
    if (this.mode.kind === 'solo') {
      title = winner?.id === this.selfId ? 'Enemy ship destroyed!' : 'Your ship was destroyed!';
    } else if (!winner) {
      title = 'All ships sank!';
    } else if (winner.id === this.selfId) {
      title = this.battleMode === 'respawn' ? `Victory! First to ${this.target} sinks!` : 'Victory! Last ship afloat!';
    } else {
      title = `${this.slotLabel(winner)} wins!`;
    }
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
