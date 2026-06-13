import { decideTurn, wantsToFire } from './ai';
import { Cannonball, drawCannonball } from './cannonball';
import { Explosion, Splash } from './explosion';
import type { Input } from './input';
import { cleanChat } from './net';
import type {
  BattleMode,
  Cloud,
  FireMode,
  GuestNet,
  HostNet,
  Iceberg,
  Island,
  MineSnap,
  NetMessage,
  ShipSnap,
  Wind,
} from './net';
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
const MIN_ISLANDS = 4;
const MAX_ISLANDS = 7;

const MINE_RADIUS = 7; // px contact radius
const MINE_BLAST = 45; // px radius when the fuse detonates it
const MINE_DAMAGE = 2; // health per hit (cannonballs do 1)
const MINE_RECHARGE = 10; // s before the next barrel is ready (one afloat at a time)
const MINE_DRIFT = 14; // px/s per unit of wind strength
const MINE_DUD_CHANCE = 0.25; // "bad fuse": fizzles instead of self-detonating
const MINE_OWNER_GRACE = 0.8; // s the dropper is immune, so they can flee their own armed barrel

const RAM_SAFE = 1.2; // s of immunity after taking a ram, so one hit ≠ many

const ICEBERG_CHANCE = 0.5; // odds any given round has icebergs at all
const ICEBERG_DAMAGE_FRAC = 0.4; // share of max health scraped off on a strike
const ICEBERG_SAFE = 3; // s of immunity after a scrape, long enough to sail clear
const ICEBERG_TIP_FRAC = 0.5; // fraction of r that a cannonball must hit to chip ice
const ICEBERG_IMPACT_DMG = 2; // hp a ramming ship knocks off the berg

const ISLAND_MAX_CRATERS = 14; // cap so a long siege doesn't grow the scar list forever
const PIER_HP = 3; // cannonball hits to blow a jetty apart

const FIRE_MODE_KEY = 'pirates-fire-mode'; // remembers volley vs rolling across games

const AUTO_PICK_AFTER = 10; // s on a rematch select before your last ship is reused

const WAKE_LIFE = 1100; // ms a foam-trail puff lingers before fading out
const WAKE_GAP = 7; // px the stern must travel before a new puff is laid

/** A floating barrel bomb. Lives until contact, its fuse, or a cannonball. */
interface Mine {
  x: number;
  y: number;
  ownerId: number;
  age: number; // s afloat
  fuse: number; // s until it self-detonates (or fizzles, for a dud)
  dud: boolean;
  armed: boolean;
  spent: boolean;
}

/** An on-screen chat line; bubbles use `until`, the feed keeps the last few. */
interface ChatLine {
  from: number;
  text: string;
  until: number; // ms epoch when it disappears
}

// One distinct hull color per player slot (host is 0).
export const PLAYER_COLORS = [
  '#8b5a2b', '#7a1f1f', '#1f5c7a', '#3f7a26', '#6b3fa0', '#a07a1f', '#a0421f', '#3fa08c',
  '#535ec8', '#b3477e', '#5a7a1f', '#1f7a5c', '#8c5ab0', '#b08c2a', '#6e6e6e', '#274fa0',
];

export type GameMode =
  | { kind: 'solo' }
  | { kind: 'host'; net: HostNet; battle: BattleMode; name: string }
  | { kind: 'guest'; net: GuestNet; code: string };

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

// Phones get touch controls and tap-flavored hint text.
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** The player's last-used fire mode, remembered across games. */
function loadFireMode(): FireMode {
  try {
    return localStorage.getItem(FIRE_MODE_KEY) === 'rolling' ? 'rolling' : 'volley';
  } catch {
    return 'volley';
  }
}

/** Cheap deterministic pseudo-random in [0, 1) — stable per (seed, n). */
function jitter(seed: number, n: number): number {
  const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** A tiny waddling penguin sipping a thick milkshake, drawn at its feet (x, y). */
function drawPenguin(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, t: number, phase: number) {
  const bob = Math.sin(t * 6 + phase) * 1.1; // waddle bounce
  const step = Math.sin(t * 8 + phase); // alternating feet
  const sipping = Math.sin(t * 0.9 + phase) > 0.55; // every so often, a sip

  ctx.save();
  ctx.translate(x, y + bob);

  // Feet.
  ctx.fillStyle = '#e6962a';
  for (const s of [-1, 1]) {
    const lift = s === Math.sign(step || 1) ? -1 : 0;
    ctx.beginPath();
    ctx.ellipse(s * 1.6, lift, 1.7, 1, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Body (black) with white belly.
  ctx.fillStyle = '#1c1c22';
  ctx.beginPath();
  ctx.ellipse(0, -4.6, 3.3, 4.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f3f3ef';
  ctx.beginPath();
  ctx.ellipse(dir * 0.4, -4.2, 2, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Back flipper.
  ctx.fillStyle = '#1c1c22';
  ctx.beginPath();
  ctx.ellipse(-dir * 2.8, -4.4, 1, 2.6, dir * 0.3, 0, Math.PI * 2);
  ctx.fill();

  // Head.
  ctx.beginPath();
  ctx.arc(0, -9.2, 2.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f3f3ef'; // face patch
  ctx.beginPath();
  ctx.arc(dir * 0.5, -8.9, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1c1c22'; // eye
  ctx.beginPath();
  ctx.arc(dir * 0.9, -9.6, 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e6962a'; // beak
  ctx.beginPath();
  ctx.moveTo(dir * 1.8, -9.1);
  ctx.lineTo(dir * 3.6, -8.7);
  ctx.lineTo(dir * 1.8, -8.2);
  ctx.closePath();
  ctx.fill();

  // Milkshake: cup + straw, raised to the beak when sipping.
  const cupX = dir * (sipping ? 2.6 : 4.2);
  const cupY = sipping ? -8.4 : -5.4;
  ctx.fillStyle = '#f7d9e6'; // thick pink shake in a pale cup
  ctx.beginPath();
  ctx.moveTo(cupX - 1.4, cupY - 1.8);
  ctx.lineTo(cupX + 1.4, cupY - 1.8);
  ctx.lineTo(cupX + 1, cupY + 1.8);
  ctx.lineTo(cupX - 1, cupY + 1.8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.4;
  ctx.stroke();
  ctx.strokeStyle = '#d34b7a'; // straw to the beak
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(cupX, cupY - 1.8);
  ctx.lineTo(dir * 2.2, -9);
  ctx.stroke();

  ctx.restore();
}

/** One player (or the solo AI) in the match. */
interface Slot {
  id: number; // 0 = host; shown by name, or "Player <id + 1>" if unnamed
  name: string; // '' = unnamed
  color: string;
  ai: boolean;
  pick: ShipTypeName | null;
  ship: Ship | null;
  input: { turn: Turn; fire: boolean; drop: boolean; restart: boolean; sail: boolean }; // latest remote keys
  score: number; // ships sunk (respawn mode)
  mineCool: number; // s until the next barrel is ready
  fireMode: FireMode;
  prevFire: boolean; // for edge-detecting presses in rolling mode
  respawnIn: number | null; // s until respawn, once fully sunk
  left: boolean; // disconnected mid-battle; never respawns
  avoid: Turn; // AI: committed island-avoidance turn (0 = clear course)
}

function newSlot(id: number, name = '', ai = false): Slot {
  return {
    id,
    name,
    color: PLAYER_COLORS[id % PLAYER_COLORS.length],
    ai,
    pick: null,
    ship: null,
    input: { turn: 0, fire: false, drop: false, restart: false, sail: false },
    score: 0,
    mineCool: 0,
    fireMode: 'volley',
    prevFire: false,
    respawnIn: null,
    left: false,
    avoid: 0,
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
  private islands: Island[] = [];
  private icebergs: Iceberg[] = [];
  private remoteIcebergs: Iceberg[] = []; // guest: icebergs from snapshots
  private pendingCraters: { i: number; x: number; y: number }[] = []; // host: new island scars to send
  private pendingPierDown: number[] = []; // host: islands whose pier blew apart this tick
  private clouds: Cloud[] = [];
  private paused = false; // host froze the battle
  private mines: Mine[] = [];
  private remoteMines: MineSnap[] = []; // guest: mines from snapshots
  private splashes: Splash[] = [];
  private pendingSplash: { x: number; y: number }[] = []; // host: splashes to send
  private chats: ChatLine[] = []; // recent banter, for the feed and bubbles
  private myFireMode: FireMode = loadFireMode();
  private prevKeyF = false; // edge detection for the fire-mode toggle
  private myFurled = false; // this player's sails-down toggle
  private prevKeyW = false; // edge detection for the sail toggle
  private wakes = new Map<number, { x: number; y: number; born: number }[]>(); // foam trails per slot
  private lastPick: ShipTypeName | null = null; // previous round's ship
  private autoPickAt: number | null = null; // ms epoch when lastPick is auto-used
  private wind: Wind = { dir: 0, strength: 0 };
  private waves: Wave[] = [];
  private lastTime = 0;

  // Multiplayer state.
  private remoteBalls: { x: number; y: number; p: number }[] = []; // guest: balls from snapshots
  private pendingBoom: { x: number; y: number }[] = []; // host: explosions to send
  private readyInfo: { ready: number; total: number } | null = null; // guest: select progress
  private disconnected = false;
  private kicked = false;
  private tapRestart = false; // tap-on-game-over stands in for the R key
  private boardToggle = false; // mobile scoreboard button held open

  constructor(ctx: CanvasRenderingContext2D, input: Input, mode: GameMode = { kind: 'solo' }) {
    this.ctx = ctx;
    this.input = input;
    this.mode = mode;
    this.selfId = mode.kind === 'guest' ? mode.net.selfId : 0;

    if (mode.kind === 'host') {
      this.battleMode = mode.battle;
      mode.net.onMessage = (id, msg) => this.handleGuestMessage(id, msg);
      mode.net.onGuestJoin = (id) => this.admitLatecomer(id);
      mode.net.onGuestLeave = (id) => this.dropPlayer(id);
    } else if (mode.kind === 'guest') {
      mode.net.onMessage = (msg) => this.handleHostMessage(msg);
      mode.net.onClose = () => {
        this.disconnected = true;
        // The host may just be refreshing their page — the room code survives
        // that, so try to rejoin (the lobby retries for a while). Not if we
        // were kicked, of course.
        if (!this.kicked) {
          setTimeout(() => {
            location.href = `${location.pathname}?join=${mode.code}&rejoin=1`;
          }, 1500);
        }
      };
    }
    this.buildSlots();
    ctx.canvas.addEventListener('pointerdown', (e) => this.onTap(e));

    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        r: 6 + Math.random() * 10,
      });
    }
  }

  /** Taps pick a ship on the select screen and restart after game over. */
  private onTap(e: PointerEvent) {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WORLD_W;
    const y = ((e.clientY - rect.top) / rect.height) * WORLD_H;

    if (this.phase === 'select' && !this.myPick) {
      (Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type, i) => {
        const cx = WORLD_W / 2 + (i - 1) * 230;
        if (Math.abs(x - cx) < 105 && Math.abs(y - WORLD_H * 0.5) < 110) this.pick(type);
      });
    } else if (this.phase === 'battle' && this.over) {
      this.tapRestart = true;
    }
  }

  /** Roster for the next battle. Guests get theirs from the start message. */
  private buildSlots() {
    if (this.mode.kind === 'solo') {
      this.slots = [newSlot(0), newSlot(1, '', true)];
    } else if (this.mode.kind === 'host') {
      const net = this.mode.net;
      this.slots = [newSlot(0, this.mode.name), ...net.guestIds.map((id) => newSlot(id, net.guestName(id)))];
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

  private mineSnaps(): MineSnap[] {
    return this.mines.map((m) => ({ x: m.x, y: m.y, armed: m.armed, urgency: m.age / m.fuse }));
  }

  private get windVec(): { x: number; y: number } {
    return {
      x: Math.cos(this.wind.dir) * this.wind.strength,
      y: Math.sin(this.wind.dir) * this.wind.strength,
    };
  }

  private get winner(): Slot | undefined {
    if (!this.over) return undefined;
    if (this.battleMode === 'respawn') return this.slots.find((s) => s.score >= this.target);
    return this.aliveSlots[0];
  }

  // --- host controls (driven by the DOM host panel) ---

  /** Current players, for the host panel's kick list. */
  get roster(): { id: number; label: string }[] {
    return this.slots.filter((s) => !s.ai && !s.left).map((s) => ({ id: s.id, label: this.slotLabel(s) }));
  }

  /** Host: change the rules for everyone, effective immediately. */
  setRules(mode: BattleMode, target: number) {
    if (this.mode.kind !== 'host') return;
    this.battleMode = mode;
    this.target = target;
    if (mode === 'elimination') {
      for (const slot of this.slots) slot.respawnIn = null;
    }
    this.mode.net.broadcast({ t: 'rules', mode, target });
  }

  /** Host: remove a player. Their connection close sinks their ship. */
  kickPlayer(id: number) {
    if (this.mode.kind === 'host') this.mode.net.kick(id);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Host: freeze or resume the battle for everyone. */
  togglePause(): boolean {
    if (this.mode.kind !== 'host' || this.phase !== 'battle') return this.paused;
    this.paused = !this.paused;
    this.mode.net.broadcast({ t: 'pause', paused: this.paused });
    return this.paused;
  }

  // --- messages ---

  private handleGuestMessage(id: number, msg: NetMessage) {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) return;
    if (msg.t === 'pick' && !slot.pick) {
      slot.pick = msg.ship;
      if (this.phase === 'select') {
        this.broadcastPicked();
        this.maybeStartBattle();
      } else if (!this.over && !slot.ship) {
        this.spawnLatecomer(slot);
      }
      // Picked while the round-over banner is up: they sail next round.
    } else if (msg.t === 'input') {
      slot.input = { turn: msg.turn, fire: msg.fire, drop: msg.drop, restart: msg.restart, sail: msg.sail };
      slot.fireMode = msg.mode;
    } else if (msg.t === 'chat') {
      const text = cleanChat(msg.text);
      if (!text || this.mode.kind !== 'host') return;
      this.recordChat(id, text);
      for (const gid of this.mode.net.guestIds) {
        if (gid !== id) this.mode.net.sendTo(gid, { t: 'chat', text, from: id });
      }
    }
  }

  /** Show a chat line in the feed and as a bubble over the sender's ship. */
  private recordChat(from: number, text: string) {
    this.chats.push({ from, text, until: Date.now() + 6500 });
    if (this.chats.length > 12) this.chats.shift();
  }

  /** Swap between full broadsides and one-gun-per-press (F key / mode button). */
  toggleFireMode() {
    this.myFireMode = this.myFireMode === 'volley' ? 'rolling' : 'volley';
    try {
      localStorage.setItem(FIRE_MODE_KEY, this.myFireMode); // remembered next game
    } catch {
      // private mode / storage disabled — fine, just won't persist
    }
    const self = this.selfSlot;
    if (self) self.fireMode = this.myFireMode;
  }

  /** Furl or set the sails (W key / sail button). */
  toggleSails(): boolean {
    if (this.phase === 'battle') this.myFurled = !this.myFurled;
    return this.myFurled;
  }

  /** Show/hide the scoreboard (mobile 🏆 button; desktop holds Tab instead). */
  toggleBoard(): boolean {
    this.boardToggle = !this.boardToggle;
    return this.boardToggle;
  }

  /** Send banter to the crew (called by the chat bar in main.ts). */
  sendChat(raw: string) {
    const text = cleanChat(raw);
    if (!text || this.mode.kind === 'solo') return;
    this.recordChat(this.selfId, text);
    if (this.mode.kind === 'host') {
      this.mode.net.broadcast({ t: 'chat', text, from: 0 });
    } else {
      this.mode.net.send({ t: 'chat', text });
    }
  }

  /** Host: a new player connected after the game left the waiting room. */
  private admitLatecomer(id: number) {
    if (this.mode.kind !== 'host' || this.slots.some((s) => s.id === id)) return;
    this.slots.push(newSlot(id, this.mode.net.guestName(id)));
    this.mode.net.sendTo(id, { t: 'go-select' }); // drop them on ship select
    this.broadcastPicked();
  }

  /** Host: a latecomer picked their ship — sail it into the running battle. */
  private spawnLatecomer(slot: Slot) {
    if (this.mode.kind !== 'host') return;
    this.spawnShip(slot, Math.random() * Math.PI * 2); // the ring is island-free
    slot.mineCool = 0;
    const net = this.mode.net;
    const spawn = {
      id: slot.id,
      name: slot.name,
      type: slot.pick!,
      x: slot.ship!.x,
      y: slot.ship!.y,
      heading: slot.ship!.heading,
    };
    // The newcomer needs the whole battle; everyone else just the new ship.
    net.sendTo(slot.id, {
      t: 'start',
      mode: this.battleMode,
      target: this.target,
      islands: this.islands,
      icebergs: this.icebergs,
      clouds: this.clouds,
      wind: this.wind,
      mines: this.mineSnaps(),
      ships: this.slots
        .filter((s) => s.ship)
        .map((s) => ({ id: s.id, name: s.name, type: s.pick!, x: s.ship!.x, y: s.ship!.y, heading: s.ship!.heading })),
    });
    for (const gid of net.guestIds) {
      if (gid !== slot.id) net.sendTo(gid, { t: 'spawn', ship: spawn });
    }
  }

  private handleHostMessage(msg: NetMessage) {
    switch (msg.t) {
      case 'go-select':
        this.resetToSelect();
        break;
      case 'rules':
        this.battleMode = msg.mode;
        this.target = msg.target;
        break;
      case 'kicked':
        this.kicked = true;
        this.disconnected = true;
        break;
      case 'pause':
        this.paused = msg.paused;
        break;
      case 'chat': {
        const text = cleanChat(msg.text);
        if (text) this.recordChat(msg.from ?? -1, text);
        break;
      }
      case 'picked':
        this.readyInfo = { ready: msg.ready, total: msg.total };
        break;
      case 'start':
        this.battleMode = msg.mode;
        this.target = msg.target;
        this.slots = msg.ships.map((sp) => {
          const slot = newSlot(sp.id, sp.name);
          slot.pick = sp.type;
          slot.ship = new Ship(sp.x, sp.y, sp.heading, slot.color, sp.type);
          return slot;
        });
        this.islands = msg.islands;
        this.icebergs = msg.icebergs;
        this.remoteIcebergs = msg.icebergs;
        this.clouds = msg.clouds;
        this.wind = msg.wind;
        this.remoteMines = msg.mines;
        this.paused = false;
        this.enterBattleFireMode();
        this.cannonballs = [];
        this.remoteBalls = [];
        this.explosions = [];
        this.phase = 'battle';
        break;
      case 'spawn': {
        const sp = msg.ship;
        const slot = newSlot(sp.id, sp.name);
        slot.pick = sp.type;
        slot.ship = new Ship(sp.x, sp.y, sp.heading, slot.color, sp.type);
        this.slots = [...this.slots.filter((s) => s.id !== sp.id), slot];
        break;
      }
      case 'state':
        if (this.phase !== 'battle') break;
        for (const snap of msg.ships) this.applySnap(snap);
        this.remoteBalls = msg.balls;
        this.remoteMines = msg.mines;
        this.remoteIcebergs = msg.icebergs;
        for (const c of msg.craters) {
          const isl = this.islands[c.i];
          if (isl) (isl.craters ??= []).push({ x: c.x, y: c.y });
        }
        for (const i of msg.piersDown) {
          const isl = this.islands[i];
          if (isl) isl.pier = undefined;
        }
        for (const b of msg.boom) this.explosions.push(new Explosion(b.x, b.y));
        for (const s of msg.splash) this.splashes.push(new Splash(s.x, s.y));
        break;
    }
  }

  private applySnap(snap: ShipSnap) {
    const slot = this.slots.find((s) => s.id === snap.id);
    if (!slot?.ship) return;
    slot.score = snap.score;
    slot.mineCool = snap.mineCool;
    const ship = slot.ship;
    ship.gunReload = snap.guns;
    ship.x = snap.x;
    ship.y = snap.y;
    ship.heading = snap.heading;
    ship.health = snap.health;
    ship.sinkProgress = snap.sink;
    ship.sailsDown = snap.sail;
  }

  /** Host: a guest's connection dropped. */
  private dropPlayer(id: number) {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) return;
    if (this.mode.kind === 'host' && this.mode.net.guestIds.length === 0) {
      // Everyone left: back to the pre-game screen. The room stays open, so
      // the invite link keeps working and joiners drop straight into select.
      this.resetToSelect();
      return;
    }
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
    // Rematch convenience: your previous ship sails again unless you pick
    // another within the countdown.
    this.lastPick = this.myPick ?? this.lastPick;
    this.autoPickAt = this.lastPick ? Date.now() + AUTO_PICK_AFTER * 1000 : null;
    this.myPick = null;
    this.tapRestart = false;
    this.readyInfo = null;
    this.cannonballs = [];
    this.remoteBalls = [];
    this.explosions = [];
    this.pendingBoom = [];
    this.mines = [];
    this.remoteMines = [];
    this.splashes = [];
    this.pendingSplash = [];
    this.icebergs = [];
    this.remoteIcebergs = [];
    this.pendingCraters = [];
    this.pendingPierDown = [];
    this.clouds = [];
    this.wakes.clear();
    this.paused = false;
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

  /**
   * Scatter islands across the whole map. The only no-go area is a band
   * around the spawn ring, so initial spawns and respawns always land on
   * open water; everything else — the middle and the outer reaches — is
   * fair game, with sailing channels kept between islands.
   */
  /** Sample points around the fleet's spawn ring, to keep hazards off it. */
  private spawnRing(): { x: number; y: number }[] {
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ring.push({
        x: WORLD_W / 2 + Math.cos(a) * WORLD_W * 0.32,
        y: WORLD_H / 2 + Math.sin(a) * WORLD_H * 0.32,
      });
    }
    return ring;
  }

  private makeIslands(): Island[] {
    const ring = this.spawnRing();
    // Piers can trap the AI, so solo (vs-AI) maps simply go without them.
    const allowPiers = this.mode.kind !== 'solo';

    const islands: Island[] = [];
    const count = MIN_ISLANDS + Math.floor(Math.random() * (MAX_ISLANDS - MIN_ISLANDS + 1));
    for (let tries = 0; islands.length < count && tries < 400; tries++) {
      const r = 35 + Math.random() * 40;
      const hasPier = allowPiers && Math.random() < 0.45;
      const candidate: Island = {
        x: r + 20 + Math.random() * (WORLD_W - 2 * r - 40),
        y: r + 20 + Math.random() * (WORLD_H - 2 * r - 40),
        r,
        pier: hasPier ? Math.random() * Math.PI * 2 : undefined,
        pierHp: hasPier ? PIER_HP : undefined,
      };
      if (ring.some((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) < r + 55)) continue;
      if (islands.some((i) => Math.hypot(i.x - candidate.x, i.y - candidate.y) < i.r + r + 100)) continue;
      islands.push(candidate);
    }
    return islands;
  }

  /**
   * Icebergs only appear some rounds. They keep clear of the spawn ring and of
   * islands; their `r` is the big submerged danger zone, far larger than the
   * tip that shows above water.
   */
  private makeIcebergs(): Iceberg[] {
    if (Math.random() > ICEBERG_CHANCE) return [];
    const ring = this.spawnRing();
    const bergs: Iceberg[] = [];
    const count = 1 + Math.floor(Math.random() * 3); // 1–3
    for (let tries = 0; bergs.length < count && tries < 200; tries++) {
      const r = 40 + Math.random() * 35;
      const hp = Math.max(3, Math.round(r / 11)); // bigger bergs take more pounding
      const candidate = {
        x: r + 20 + Math.random() * (WORLD_W - 2 * r - 40),
        y: r + 20 + Math.random() * (WORLD_H - 2 * r - 40),
        r,
        hp,
        maxHp: hp,
      };
      // Keep clear of the spawn ring — the danger radius, not just the tip —
      // so nobody starts the round already inside an iceberg.
      if (ring.some((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) < r + 55)) continue;
      if (this.islands.some((i) => Math.hypot(i.x - candidate.x, i.y - candidate.y) < i.r + r + 40)) continue;
      if (bergs.some((b) => Math.hypot(b.x - candidate.x, b.y - candidate.y) < b.r + r + 60)) continue;
      bergs.push(candidate);
    }
    return bergs;
  }

  /**
   * A few translucent clouds that drift downwind. Each gets a fixed set of
   * puff lobes (so the silhouette is stable and identical on every client)
   * and its own opacity anywhere from clear to fully solid.
   */
  private makeClouds(): Cloud[] {
    const clouds: Cloud[] = [];
    const count = 2 + Math.floor(Math.random() * 3); // 2–4
    for (let i = 0; i < count; i++) {
      const r = 90 + Math.random() * 90;
      const lobeCount = 4 + Math.floor(Math.random() * 3); // 4–6
      const lobes = [{ dx: 0, dy: 0, r: r * 0.7 }]; // body
      for (let j = 0; j < lobeCount; j++) {
        const a = (j / lobeCount) * Math.PI * 2 + Math.random() * 0.7;
        const off = r * (0.28 + Math.random() * 0.38);
        lobes.push({ dx: Math.cos(a) * off, dy: Math.sin(a) * off * 0.6, r: r * (0.42 + Math.random() * 0.4) });
      }
      clouds.push({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        r,
        speed: 14 + Math.random() * 16,
        alpha: Math.random(), // 0 (invisible) … 1 (a solid bank you can hide behind)
        lobes,
      });
    }
    return clouds;
  }

  /** Advance the clouds along the wind; wrap each axis when fully off-screen. */
  private moveClouds(dt: number) {
    const dx = Math.cos(this.wind.dir);
    const dy = Math.sin(this.wind.dir);
    for (const c of this.clouds) {
      c.x += dx * c.speed * dt;
      c.y += dy * c.speed * dt;
      const m = c.r + 80;
      if (c.x < -m) c.x = WORLD_W + m;
      if (c.x > WORLD_W + m) c.x = -m;
      if (c.y < -m) c.y = WORLD_H + m;
      if (c.y > WORLD_H + m) c.y = -m;
    }
  }

  /** Host/solo: once everyone has picked, spawn the fleet in a ring and go. */
  private maybeStartBattle() {
    if (this.phase !== 'select' || this.slots.some((s) => !s.pick)) return;
    if (this.mode.kind === 'host' && this.slots.length < 2) return; // wait for a crew

    const n = this.slots.length;
    this.slots.forEach((slot, i) => {
      this.spawnShip(slot, (i / n) * Math.PI * 2 - Math.PI / 2);
    });
    this.islands = this.makeIslands();
    this.icebergs = this.makeIcebergs();
    this.wind = { dir: Math.random() * Math.PI * 2, strength: 0.08 + Math.random() * 0.32 };
    this.clouds = this.makeClouds();
    this.mines = [];
    this.paused = false;
    this.enterBattleFireMode();
    for (const slot of this.slots) slot.mineCool = 0;
    this.cannonballs = [];
    this.explosions = [];
    this.pendingBoom = [];
    this.phase = 'battle';

    if (this.mode.kind === 'host') {
      this.mode.net.broadcast({
        t: 'start',
        mode: this.battleMode,
        target: this.target,
        islands: this.islands,
        icebergs: this.icebergs,
        clouds: this.clouds,
        wind: this.wind,
        mines: this.mineSnaps(),
        ships: this.slots.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.pick!,
          x: s.ship!.x,
          y: s.ship!.y,
          heading: s.ship!.heading,
        })),
      });
    }
  }

  /** Every battle opens with sails set and your remembered fire mode; keep the
   * self slot's state in lockstep with the HUD so they never disagree. */
  private enterBattleFireMode() {
    this.myFurled = false;
    const self = this.selfSlot;
    if (self) self.fireMode = this.myFireMode;
  }

  /**
   * Distance (px) the ship can sail holding `turn` before grounding, simulated
   * along its real turning arc. Lookahead is a fixed *distance* (not time) so a
   * slow, sluggish hull still spots a big island in time to arc clear — every
   * hull's turning radius is similar, so they need similar room. Infinity =
   * clear horizon.
   */
  private pathClearance(ship: Ship, turn: Turn, look = 230): number {
    // Assume the worst-case tailwind throughout so the dodge is never started
    // later than the real (wind-boosted) ship would need.
    const speed = ship.speed * (1 + this.wind.strength);
    const step = 0.1;
    let x = ship.x;
    let y = ship.y;
    let h = ship.heading;
    let traveled = 0;
    while (traveled < look) {
      h += turn * ship.turnRate * step;
      x += Math.cos(h) * speed * step;
      y += Math.sin(h) * speed * step;
      x = ((x % WORLD_W) + WORLD_W) % WORLD_W; // mirror the world wrap
      y = ((y % WORLD_H) + WORLD_H) % WORLD_H;
      traveled += speed * step;
      for (const isl of this.islands) {
        if (Math.hypot(x - isl.x, y - isl.y) < isl.r + ship.width / 2 + 12) return traveled;
        if (this.pierDist(x, y, isl) < Game.PIER_HALF_W + ship.width / 2 + 12) return traveled;
      }
      for (const berg of this.icebergs) {
        if (Math.hypot(x - berg.x, y - berg.y) < berg.r + ship.width / 2 + 12) return traveled;
      }
    }
    return Infinity;
  }

  /**
   * AI steering: take the chase turn if its whole arc is island-free;
   * otherwise stick with the committed dodge, then try the remaining turn
   * options, and failing all, the option that grounds furthest away. Arc
   * simulation (not a look-ahead cone) is what keeps a dodge from sweeping
   * the ship into a *different* island behind its turn.
   */
  private aiTurn(slot: Slot, ship: Ship, target: Ship | null): Turn {
    const chase: Turn = !this.over && target ? decideTurn(ship, target) : 0;

    // Mid-dodge: hold the committed turn until sailing *straight ahead* is
    // clear, not merely until the curved chase reads clear — otherwise the
    // chase keeps grazing the obstacle and the ship dithers onto it.
    if (slot.avoid !== 0) {
      if (this.pathClearance(ship, 0) === Infinity) {
        slot.avoid = 0; // safely past — resume normal steering
      } else {
        const other: Turn = slot.avoid === 1 ? -1 : 1;
        // Swap sides only if the committed side is closing out and the other is open.
        if (this.pathClearance(ship, slot.avoid) < 70 && this.pathClearance(ship, other) === Infinity) {
          slot.avoid = other;
        }
        return slot.avoid;
      }
    }

    // Free to chase if that arc is clear; otherwise commit to the better dodge.
    if (this.pathClearance(ship, chase) === Infinity) return chase;
    const left = this.pathClearance(ship, -1);
    const right = this.pathClearance(ship, 1);
    slot.avoid = right >= left ? 1 : -1;
    return slot.avoid;
  }

  // Pier geometry, shared by drawing, collision, and AI avoidance.
  private static PIER_HALF_W = 5;
  private pierExtent(isl: Island) {
    return { inner: isl.r * 0.5, outer: isl.r + 26 + isl.r * 0.45 };
  }

  /** Distance from a point to an island's pier segment (Infinity if none). */
  private pierDist(px: number, py: number, isl: Island): number {
    if (isl.pier == null) return Infinity;
    const dx = Math.cos(isl.pier);
    const dy = Math.sin(isl.pier);
    const { inner, outer } = this.pierExtent(isl);
    const ax = isl.x + dx * inner;
    const ay = isl.y + dy * inner;
    const abx = dx * (outer - inner);
    const aby = dy * (outer - inner);
    const len2 = abx * abx + aby * aby;
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
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

    // Frozen by the host: hold everything where it is, the overlay does the rest.
    if (this.paused) return;

    // The waves and clouds run with the wind — an ambient cue for its direction.
    for (const wave of this.waves) {
      wave.x = (wave.x + this.windVec.x * 60 * dt + WORLD_W) % WORLD_W;
      wave.y = (wave.y + this.windVec.y * 60 * dt + WORLD_H) % WORLD_H;
    }
    this.moveClouds(dt);

    const keyF = this.input.isDown('KeyF');
    if (keyF && !this.prevKeyF) this.toggleFireMode();
    this.prevKeyF = keyF;

    const keyW = this.input.isDown('KeyW');
    if (keyW && !this.prevKeyW) this.toggleSails();
    this.prevKeyW = keyW;

    let turn: Turn = 0;
    if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) turn = -1;
    if (this.input.isDown('ArrowRight') || this.input.isDown('KeyD')) turn = 1;

    if (this.mode.kind === 'guest') {
      this.mode.net.send({
        t: 'input',
        turn,
        fire: this.input.isDown('Space'),
        drop: this.input.isDown('KeyS') || this.input.isDown('ArrowDown'),
        restart: this.over && (this.input.isDown('KeyR') || this.tapRestart),
        mode: this.myFireMode,
        sail: this.myFurled,
      });
      // The host simulates; we just animate our local effects.
      for (const ex of this.explosions) ex.update(dt);
      this.explosions = this.explosions.filter((ex) => !ex.done);
      for (const sp of this.splashes) sp.update(dt);
      this.splashes = this.splashes.filter((sp) => !sp.done);
      return;
    }

    if (
      this.over &&
      (this.input.isDown('KeyR') || this.tapRestart || this.slots.some((s) => s.input.restart))
    ) {
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
      let drop = false;
      let sailsDown = false;
      if (slot.id === this.selfId) {
        shipTurn = turn;
        fire = this.input.isDown('Space');
        drop = this.input.isDown('KeyS') || this.input.isDown('ArrowDown');
        sailsDown = this.myFurled;
      } else if (slot.ai) {
        const target = this.nearestEnemy(ship);
        shipTurn = this.aiTurn(slot, ship, target);
        fire = !this.over && target ? wantsToFire(ship, target) : false;
      } else {
        shipTurn = slot.input.turn;
        fire = slot.input.fire;
        drop = slot.input.drop;
        sailsDown = slot.input.sail;
      }

      ship.update(dt, shipTurn, WORLD_W, WORLD_H, this.windVec, sailsDown);

      // Running into an island — or its solid wooden pier — sinks the ship
      // outright (no scorer).
      if (ship.alive) {
        for (const isl of this.islands) {
          const hitLand = Math.hypot(ship.x - isl.x, ship.y - isl.y) < isl.r + ship.width / 2;
          const hitPier = this.pierDist(ship.x, ship.y, isl) < Game.PIER_HALF_W + ship.width / 2;
          if (hitLand || hitPier) {
            ship.health = 0;
            this.explosions.push(new Explosion(ship.x, ship.y));
            this.pendingBoom.push({ x: ship.x, y: ship.y });
            break;
          }
        }
      }

      // Scraping an iceberg's submerged bulk gouges a chunk of health — but
      // a few seconds' immunity stops it grinding you down every frame. The
      // collision also splinters the berg, which can shatter it outright.
      if (ship.alive && ship.bergSafe <= 0) {
        for (const berg of this.icebergs) {
          if (Math.hypot(ship.x - berg.x, ship.y - berg.y) < berg.r + ship.width / 2) {
            const dmg = Math.max(1, Math.ceil(ship.maxHealth * ICEBERG_DAMAGE_FRAC));
            for (let i = 0; i < dmg; i++) ship.takeHit();
            ship.bergSafe = ICEBERG_SAFE;
            this.damageBerg(berg, ICEBERG_IMPACT_DMG, ship.x, ship.y);
            break;
          }
        }
      }

      const firePressed = fire && !slot.prevFire;
      slot.prevFire = fire;
      if (!this.over && ship.alive) {
        const target = this.nearestEnemy(ship);
        if (target) {
          if (slot.fireMode === 'volley') {
            // Hold to loose the full broadside as soon as every gun is ready.
            if (fire && ship.allLoaded) {
              this.fireGuns(slot, target, ship.gunReload.map((_, i) => i));
            }
          } else if (firePressed && ship.nextLoadedGun >= 0) {
            // Rolling fire: each press discharges the next loaded gun.
            this.fireGuns(slot, target, [ship.nextLoadedGun]);
          }
        }
      }

      slot.mineCool = Math.max(0, slot.mineCool - dt);
      const hasMineAfloat = this.mines.some((m) => m.ownerId === slot.id && !m.spent);
      if (!this.over && drop && ship.alive && slot.mineCool <= 0 && !hasMineAfloat) {
        this.mines.push({
          x: ship.x - Math.cos(ship.heading) * (ship.length / 2 + 14), // off the stern
          y: ship.y - Math.sin(ship.heading) * (ship.length / 2 + 14),
          ownerId: slot.id,
          age: 0,
          fuse: 10 + Math.random() * 10,
          dud: Math.random() < MINE_DUD_CHANCE,
          armed: true, // live the instant it hits the water, to stop a chaser
          spent: false,
        });
        slot.mineCool = MINE_RECHARGE;
      }
    }

    this.resolveRams();
    this.updateMines(dt);

    for (const ball of this.cannonballs) {
      ball.update(dt);
      if (ball.p >= 1) {
        // Flew its full range: splash into the sea.
        this.splashes.push(new Splash(ball.x, ball.y));
        this.pendingSplash.push({ x: ball.x, y: ball.y });
        continue;
      }
      if (ball.spent) continue;
      // Cannonballs detonate barrels harmlessly — the counter to a minefield.
      for (const mine of this.mines) {
        if (!mine.spent && Math.hypot(ball.x - mine.x, ball.y - mine.y) < MINE_RADIUS + 3) {
          mine.spent = true;
          ball.spent = true;
          this.explosions.push(new Explosion(mine.x, mine.y));
          this.pendingBoom.push({ x: mine.x, y: mine.y });
          break;
        }
      }
      if (ball.spent) continue;
      // Cannonballs that strike the visible ice chip away at the berg.
      for (const berg of this.icebergs) {
        if (Math.hypot(ball.x - berg.x, ball.y - berg.y) < berg.r * ICEBERG_TIP_FRAC) {
          ball.spent = true;
          this.damageBerg(berg, 1, ball.x, ball.y);
          break;
        }
      }
      if (ball.spent) continue;
      // A jetty out over the water is shootable; enough hits blow it apart.
      for (let bi = 0; bi < this.islands.length; bi++) {
        const isl = this.islands[bi];
        if (isl.pier == null) continue;
        if (this.pierDist(ball.x, ball.y, isl) < Game.PIER_HALF_W + 3) {
          ball.spent = true;
          this.damagePier(bi, ball.x, ball.y);
          break;
        }
      }
      if (ball.spent) continue;
      for (let bi = 0; bi < this.islands.length; bi++) {
        const isl = this.islands[bi];
        if (Math.hypot(ball.x - isl.x, ball.y - isl.y) < isl.r) {
          ball.spent = true; // cannonballs don't pass through islands — they scar them
          this.addCrater(bi, ball.x, ball.y);
          this.explosions.push(new Explosion(ball.x, ball.y));
          this.pendingBoom.push({ x: ball.x, y: ball.y });
          break;
        }
      }
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
    for (const sp of this.splashes) sp.update(dt);
    this.splashes = this.splashes.filter((sp) => !sp.done);

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
          guns: s.ship!.gunReload,
          mineCool: s.mineCool,
          sail: s.ship!.sailsDown,
        })),
        balls: this.cannonballs.map((b) => ({ x: b.x, y: b.y, p: b.p })),
        mines: this.mineSnaps(),
        icebergs: this.icebergs,
        craters: this.pendingCraters,
        piersDown: this.pendingPierDown,
        boom: this.pendingBoom,
        splash: this.pendingSplash,
      });
      this.pendingBoom = [];
      this.pendingSplash = [];
      this.pendingCraters = [];
      this.pendingPierDown = [];
    }
  }

  private pick(type: ShipTypeName) {
    if (this.phase !== 'select' || this.myPick) return;
    this.myPick = type;
    if (this.mode.kind === 'guest') {
      this.mode.net.send({ t: 'pick', ship: type });
      return;
    }
    const self = this.selfSlot;
    if (self) self.pick = type;
    if (this.mode.kind === 'solo') {
      const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
      this.slots.find((s) => s.ai)!.pick = types[Math.floor(Math.random() * types.length)];
    }
    this.broadcastPicked();
    this.maybeStartBattle();
  }

  /**
   * Ramming: a bow buried in another hull costs the rammed ship half its max
   * health. A short immunity keeps one collision from landing every frame;
   * head-on collisions gore both ships.
   */
  private resolveRams() {
    if (this.over) return;
    for (const attacker of this.slots) {
      const ram = attacker.ship;
      if (!ram?.alive) continue;
      const bowX = ram.x + (Math.cos(ram.heading) * ram.length) / 2;
      const bowY = ram.y + (Math.sin(ram.heading) * ram.length) / 2;
      for (const victim of this.slots) {
        if (victim === attacker) continue;
        const hull = victim.ship;
        if (!hull?.alive || hull.ramSafe > 0 || !hull.containsPoint(bowX, bowY)) continue;
        hull.ramSafe = RAM_SAFE;
        const dmg = Math.ceil(hull.maxHealth / 2);
        for (let i = 0; i < dmg; i++) hull.takeHit();
        if (!hull.alive) attacker.score++;
        this.explosions.push(new Explosion(bowX, bowY));
        this.pendingBoom.push({ x: bowX, y: bowY });
      }
    }
  }

  /** Host/solo: drift, arming, fuses, and contact/blast damage for barrels. */
  private updateMines(dt: number) {
    for (const mine of this.mines) {
      mine.age += dt;

      // Barrels ride the wind, but beach against islands.
      const nx = mine.x + this.windVec.x * MINE_DRIFT * dt * 4;
      const ny = mine.y + this.windVec.y * MINE_DRIFT * dt * 4;
      if (this.islands.every((i) => Math.hypot(nx - i.x, ny - i.y) > i.r + MINE_RADIUS)) {
        mine.x = nx;
        mine.y = ny;
      }

      if (mine.age >= mine.fuse) {
        // The fuse runs out: most barrels blast everything nearby; a dud
        // just fizzles into the sea with a splash.
        mine.spent = true;
        if (!mine.dud) {
          this.detonate(mine, MINE_BLAST);
        } else {
          this.splashes.push(new Splash(mine.x, mine.y));
          this.pendingSplash.push({ x: mine.x, y: mine.y });
        }
        continue;
      }

      if (this.over) continue;
      for (const slot of this.slots) {
        const ship = slot.ship;
        if (!ship?.alive) continue;
        // The dropper gets a brief grace so they don't blow themselves up while
        // sailing clear; everyone else triggers it on contact immediately.
        if (slot.id === mine.ownerId && mine.age < MINE_OWNER_GRACE) continue;
        if (Math.hypot(ship.x - mine.x, ship.y - mine.y) < MINE_RADIUS + ship.width / 2) {
          mine.spent = true;
          this.detonate(mine, MINE_BLAST);
          break;
        }
      }
    }
    this.mines = this.mines.filter((m) => !m.spent);
  }

  /** Chip an iceberg; shatter and remove it once its ice is spent. */
  private damageBerg(berg: Iceberg, dmg: number, x: number, y: number) {
    berg.hp -= dmg;
    this.explosions.push(new Explosion(x, y));
    this.pendingBoom.push({ x, y });
    if (berg.hp <= 0) {
      this.icebergs = this.icebergs.filter((b) => b !== berg);
      // A burst of ice and spray where it stood.
      for (let i = 0; i < 4; i++) {
        const ex = berg.x + (Math.random() - 0.5) * berg.r * 1.2;
        const ey = berg.y + (Math.random() - 0.5) * berg.r * 1.2;
        this.explosions.push(new Explosion(ex, ey));
        this.pendingBoom.push({ x: ex, y: ey });
      }
      this.splashes.push(new Splash(berg.x, berg.y));
      this.pendingSplash.push({ x: berg.x, y: berg.y });
    }
  }

  /** Pound an island's pier; blow it apart (and free the lane) when it's spent. */
  private damagePier(i: number, x: number, y: number) {
    const isl = this.islands[i];
    isl.pierHp = (isl.pierHp ?? PIER_HP) - 1;
    this.explosions.push(new Explosion(x, y));
    this.pendingBoom.push({ x, y });
    if (isl.pierHp <= 0) {
      isl.pier = undefined; // no longer solid, no longer drawn
      isl.pierHp = undefined;
      this.pendingPierDown.push(i);
      // splintered planks fly
      for (let k = 0; k < 3; k++) {
        const ex = x + (Math.random() - 0.5) * 26;
        const ey = y + (Math.random() - 0.5) * 26;
        this.explosions.push(new Explosion(ex, ey));
        this.pendingBoom.push({ x: ex, y: ey });
      }
    }
  }

  /** Record a cannonball scar on an island (cosmetic; islands never sink). */
  private addCrater(i: number, x: number, y: number) {
    const isl = this.islands[i];
    if (!isl.craters) isl.craters = [];
    if (isl.craters.length >= ISLAND_MAX_CRATERS) isl.craters.shift();
    isl.craters.push({ x, y });
    this.pendingCraters.push({ i, x, y });
  }

  /** Blow a barrel: damage every ship in the blast and credit the owner. */
  private detonate(mine: Mine, radius: number) {
    for (const slot of this.slots) {
      const ship = slot.ship;
      if (!ship?.alive) continue;
      if (Math.hypot(ship.x - mine.x, ship.y - mine.y) > radius + ship.width / 2) continue;
      for (let i = 0; i < MINE_DAMAGE; i++) ship.takeHit();
      if (!ship.alive && slot.id !== mine.ownerId) {
        const owner = this.slots.find((s) => s.id === mine.ownerId);
        if (owner) owner.score++;
      }
    }
    this.explosions.push(new Explosion(mine.x, mine.y));
    this.explosions.push(new Explosion(mine.x + 6, mine.y - 5));
    this.pendingBoom.push({ x: mine.x, y: mine.y }, { x: mine.x + 6, y: mine.y - 5 });
  }

  private updateSelect() {
    if (this.myPick) return;
    for (const [code, type] of Object.entries(SELECT_KEYS)) {
      if (this.input.isDown(code)) {
        this.pick(type);
        return;
      }
    }
    if (this.lastPick && this.autoPickAt !== null && Date.now() >= this.autoPickAt) {
      this.pick(this.lastPick);
    }
  }

  /** Fire the given guns from whichever side of the shooter faces the target. */
  private fireGuns(shooterSlot: Slot, target: Ship, gunIndices: number[]) {
    const shooter = shooterSlot.ship!;
    const reload = shooterSlot.ai ? AI_RELOAD : PLAYER_RELOAD;
    const bearing = Math.atan2(target.y - shooter.y, target.x - shooter.x);
    const side = Math.sin(bearing - shooter.heading) >= 0 ? 1 : -1;
    const dir = shooter.heading + (side * Math.PI) / 2;

    const fx = Math.cos(shooter.heading);
    const fy = Math.sin(shooter.heading);
    const sx = Math.cos(dir);
    const sy = Math.sin(dir);

    for (const i of gunIndices) {
      const along = (i / (shooter.guns - 1) - 0.5) * (shooter.length / 2);
      this.cannonballs.push(
        new Cannonball(
          shooter.x + fx * along + sx * (shooter.width / 2),
          shooter.y + fy * along + sy * (shooter.width / 2),
          dir,
          shooterSlot.id,
        ),
      );
      shooter.gunReload[i] = reload;
    }
  }

  // --- rendering ---

  private render() {
    this.drawSea();
    if (this.phase === 'select') {
      this.drawShipSelect();
    } else {
      const ctx = this.ctx;
      const now = performance.now();
      this.drawIslands();
      this.drawIcebergs();
      this.drawPenguins(now);
      this.recordWakes(now);
      this.drawWakes(now);
      this.drawMines();
      for (const sp of this.splashes) sp.draw(ctx);
      if (this.mode.kind === 'guest') {
        for (const ball of this.remoteBalls) drawCannonball(ctx, ball.x, ball.y, ball.p);
      } else {
        for (const ball of this.cannonballs) ball.draw(ctx);
      }
      for (const slot of this.slots) slot.ship?.draw(ctx);
      for (const slot of this.slots) this.drawShipTag(slot);
      for (const ex of this.explosions) ex.draw(ctx);
      this.drawChatBubbles();

      // Clouds drift above the sea and ships, dimming the view, but stay
      // beneath the HUD so dials and bars are always readable.
      this.drawClouds();

      this.slots.forEach((slot, row) => {
        if (slot.ship) this.drawHealthRow(slot, row);
      });

      this.drawWind();
      this.drawWeaponBars();
      this.drawHints();
      this.drawRespawnNotice();
      if (this.over) this.drawScoreboard(true);
      else if (this.input.isDown('Tab') || this.boardToggle) this.drawScoreboard(false);
    }

    this.drawChatFeed();
    if (this.paused) this.drawPaused();
    if (this.disconnected) this.drawDisconnected();
  }

  private slotLabel(slot: Slot): string {
    if (slot.id === this.selfId) return 'You';
    if (slot.ai) return 'Enemy';
    return slot.name || `Player ${slot.id + 1}`;
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
    const tag = slot.id === this.selfId ? 'You' : slot.name.slice(0, 10) || `P${slot.id + 1}`;
    ctx.fillText(tag, ship.x, ship.y - ship.length / 2 - 8);
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

  private drawIslands() {
    const ctx = this.ctx;
    for (const isl of this.islands) {
      // A slightly lumpy blob. The bumps are seeded from the island's own
      // coordinates, so every client draws the identical shape.
      const blob = (radius: number) => {
        ctx.beginPath();
        for (let i = 0; i <= 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          const wobble = 1 + 0.1 * Math.sin(a * 3 + isl.x) + 0.07 * Math.cos(a * 5 + isl.y);
          const px = isl.x + Math.cos(a) * radius * wobble;
          const py = isl.y + Math.sin(a) * radius * wobble;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
      };

      // A pier juts out over the water before the sand is drawn, so the
      // planks read as sitting on the surface. (`!= null` catches the `null`
      // that the wire serializer turns our `undefined` into on guests.)
      if (isl.pier != null) this.drawPier(isl);

      blob(isl.r);
      ctx.fillStyle = '#d9c38a'; // sand
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();

      blob(isl.r * 0.55);
      ctx.fillStyle = '#4f7a3a'; // scrub on top
      ctx.fill();

      this.drawBuildings(isl);

      // Cannonball scars: dark blast craters that accrue but never sink the isle.
      if (isl.craters) {
        for (const c of isl.craters) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(40, 28, 16, 0.55)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(c.x, c.y, 1.4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(20, 12, 6, 0.7)';
          ctx.fill();
        }
      }
    }
  }

  /** A hut or two (and a lighthouse on the bigger isles) for some islands. */
  private drawBuildings(isl: Island) {
    const seed = isl.x * 0.09 + isl.y * 0.11;
    if (jitter(seed, 50) < 0.45) return; // only some islands are settled
    const ctx = this.ctx;
    const huts = 1 + Math.floor(jitter(seed, 51) * 2); // 1–2 huts
    for (let i = 0; i < huts; i++) {
      const a = jitter(seed, 60 + i) * Math.PI * 2;
      const rad = isl.r * (0.12 + jitter(seed, 70 + i) * 0.28);
      const x = isl.x + Math.cos(a) * rad;
      const y = isl.y + Math.sin(a) * rad;
      const s = 4 + jitter(seed, 80 + i) * 2;
      // wall
      ctx.fillStyle = '#b07a44';
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      // roof
      ctx.beginPath();
      ctx.moveTo(x - s / 2 - 1, y - s / 2);
      ctx.lineTo(x, y - s / 2 - s * 0.7);
      ctx.lineTo(x + s / 2 + 1, y - s / 2);
      ctx.closePath();
      ctx.fillStyle = '#7a3b2a';
      ctx.fill();
      ctx.stroke();
    }
    // A lighthouse crowns large, settled islands.
    if (isl.r > 55 && jitter(seed, 90) > 0.4) {
      const x = isl.x;
      const y = isl.y - isl.r * 0.1;
      ctx.fillStyle = '#eee';
      ctx.fillRect(x - 2.5, y - 12, 5, 12);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(x - 2.5, y - 9, 5, 2.5);
      ctx.fillRect(x - 2.5, y - 4, 5, 2.5);
      ctx.fillStyle = '#ffd75e'; // lit lantern room
      ctx.fillRect(x - 1.8, y - 14, 3.6, 2.6);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x - 2.5, y - 12, 5, 12);
    }
  }

  /** A wooden jetty extending from an island into the water. */
  private drawPier(isl: Island) {
    const ctx = this.ctx;
    const a = isl.pier!;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy; // perpendicular, for plank width
    const py = dx;
    const inner = isl.r * 0.5;
    const outer = isl.r + 26 + isl.r * 0.45; // reaches out past the sand
    const halfW = 5;

    ctx.save();
    // deck
    ctx.beginPath();
    ctx.moveTo(isl.x + dx * inner + px * halfW, isl.y + dy * inner + py * halfW);
    ctx.lineTo(isl.x + dx * outer + px * halfW, isl.y + dy * outer + py * halfW);
    ctx.lineTo(isl.x + dx * outer - px * halfW, isl.y + dy * outer - py * halfW);
    ctx.lineTo(isl.x + dx * inner - px * halfW, isl.y + dy * inner - py * halfW);
    ctx.closePath();
    ctx.fillStyle = '#7a5230';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // plank seams + support posts
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    for (let t = 0.15; t < 1; t += 0.18) {
      const cx = isl.x + dx * (inner + (outer - inner) * t);
      const cy = isl.y + dy * (inner + (outer - inner) * t);
      ctx.beginPath();
      ctx.moveTo(cx + px * halfW, cy + py * halfW);
      ctx.lineTo(cx - px * halfW, cy - py * halfW);
      ctx.stroke();
    }
    ctx.fillStyle = '#5a3c22';
    for (const t of [0.55, 1]) {
      const cx = isl.x + dx * (inner + (outer - inner) * t);
      const cy = isl.y + dy * (inner + (outer - inner) * t);
      for (const s of [1, -1]) {
        ctx.beginPath();
        ctx.arc(cx + px * halfW * s, cy + py * halfW * s, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Icebergs: an irregular ice shard above water. The submerged bulk is left
   * almost invisible on purpose — you can't read the true danger radius, so
   * they're easy to blunder into (the whole Titanic point).
   */
  private drawIcebergs() {
    const ctx = this.ctx;
    const bergs = this.mode.kind === 'guest' ? this.remoteIcebergs : this.icebergs;
    for (const berg of bergs) {
      const seed = berg.x * 0.13 + berg.y * 0.17;
      const rot = jitter(seed, 1) * Math.PI;
      const aspect = 0.55 + jitter(seed, 2) * 0.7; // squashed one way → irregular
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      // Barely-there hint of the submerged mass — almost imperceptible.
      ctx.beginPath();
      ctx.arc(berg.x, berg.y, berg.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(195, 222, 240, 0.05)';
      ctx.fill();

      // Jagged tip, elongated and rotated for an irregular silhouette.
      const tip = berg.r * 0.42;
      const facets = 11;
      const pt = (a: number, scale = 1) => {
        const wob = (0.45 + 0.8 * jitter(seed, Math.round(a * 100) + 5)) * scale;
        const lx = Math.cos(a) * tip * wob;
        const ly = Math.sin(a) * tip * wob * aspect;
        return [berg.x + lx * cosR - ly * sinR, berg.y + lx * sinR + ly * cosR] as const;
      };

      ctx.beginPath();
      for (let i = 0; i <= facets; i++) {
        const [rx, ry] = pt((i / facets) * Math.PI * 2);
        i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.fillStyle = '#e8f4fb';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120, 160, 185, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // A shaded inner facet for a touch of 3D.
      const [ax, ay] = pt(rot - 1.1, 0.5);
      const [bx, by] = pt(rot + 0.7, 0.55);
      ctx.beginPath();
      ctx.moveTo(berg.x, berg.y);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = 'rgba(168, 202, 224, 0.6)';
      ctx.fill();

      // Cracks spider out from the centre as the ice gets pounded.
      const cracks = Math.round((1 - berg.hp / berg.maxHp) * 5);
      if (cracks > 0) {
        ctx.strokeStyle = 'rgba(95, 130, 155, 0.85)';
        ctx.lineWidth = 0.8;
        for (let c = 0; c < cracks; c++) {
          const [ex, ey] = pt((c / 5) * Math.PI * 2 + 0.4, 0.85);
          ctx.beginPath();
          ctx.moveTo(berg.x, berg.y);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * Clouds drifting over the battlefield. Each is one flattened path of puff
   * lobes filled a single time, so a self-overlapping shape stays one uniform
   * opacity instead of banding where lobes cross.
   */
  private drawClouds() {
    const ctx = this.ctx;
    for (const c of this.clouds) {
      ctx.beginPath();
      for (const lobe of c.lobes) {
        const lx = c.x + lobe.dx;
        const ly = c.y + lobe.dy;
        ctx.moveTo(lx + lobe.r, ly);
        ctx.arc(lx, ly, lobe.r, 0, Math.PI * 2);
      }
      ctx.fillStyle = `rgba(234, 241, 248, ${c.alpha})`;
      ctx.fill(); // nonzero winding unions the lobes → one flat opacity
    }
  }

  /**
   * Lay down foam puffs behind each moving hull. Driven off rendered position
   * so it works the same on the host, solo, and guests (whose ships move via
   * snapshots). Purely cosmetic — never networked.
   */
  private recordWakes(now: number) {
    for (const slot of this.slots) {
      const ship = slot.ship;
      let pts = this.wakes.get(slot.id);
      if (ship && ship.alive && ship.sinkProgress === 0) {
        const sx = ship.x - Math.cos(ship.heading) * (ship.length / 2);
        const sy = ship.y - Math.sin(ship.heading) * (ship.length / 2);
        if (!pts) {
          pts = [];
          this.wakes.set(slot.id, pts);
        }
        const last = pts[pts.length - 1];
        const d = last ? Math.hypot(sx - last.x, sy - last.y) : Infinity;
        if (d > 60) pts.length = 0; // teleport / world-wrap: don't streak across
        if (!last || d > WAKE_GAP) pts.push({ x: sx, y: sy, born: now });
      }
      if (pts) {
        const live = pts.filter((p) => now - p.born < WAKE_LIFE);
        if (live.length) this.wakes.set(slot.id, live);
        else this.wakes.delete(slot.id);
      }
    }
  }

  private drawWakes(now: number) {
    const ctx = this.ctx;
    for (const pts of this.wakes.values()) {
      for (const p of pts) {
        const age = (now - p.born) / WAKE_LIFE; // 0 → 1
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + age * 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${(1 - age) * 0.3})`;
        ctx.fill();
      }
    }
  }

  /** Little tuxedoed locals waddling about each iceberg, milkshakes in flipper. */
  private drawPenguins(now: number) {
    const t = now / 1000;
    const bergs = this.mode.kind === 'guest' ? this.remoteIcebergs : this.icebergs;
    for (const berg of bergs) {
      const seed = berg.x * 0.07 + berg.y * 0.05;
      const count = Math.min(3, 1 + Math.floor(berg.r / 30));
      for (let i = 0; i < count; i++) {
        const phase = jitter(seed, i) * Math.PI * 2;
        const dir = jitter(seed, i + 7) > 0.5 ? 1 : -1;
        const orbit = berg.r * (0.1 + jitter(seed, i + 3) * 0.16); // up on the visible ice
        const ang = phase + t * 0.35 * dir;
        const px = berg.x + Math.cos(ang) * orbit;
        const py = berg.y + Math.sin(ang) * orbit * 0.85;
        // Face the way they're walking (tangent's x sign).
        const facing = -Math.sin(ang) * dir >= 0 ? 1 : -1;
        drawPenguin(this.ctx, px, py, facing, t, phase);
      }
    }
  }

  /** Frozen-by-host overlay. */
  private drawPaused() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10, 25, 40, 0.55)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText('⏸ Paused', WORLD_W / 2, WORLD_H / 2 - 16);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText(
      this.mode.kind === 'host' ? 'Press Resume to continue' : 'The host paused the battle',
      WORLD_W / 2,
      WORLD_H / 2 + 26,
    );
  }

  /** Faint bottom-right nudges so desktop players find chat and the scoreboard. */
  private drawHints() {
    if (TOUCH || this.over) return;
    const ctx = this.ctx;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    let y = WORLD_H - 14;
    if (this.mode.kind !== 'solo') {
      ctx.fillText('Press Enter to chat', WORLD_W - 16, y);
      y -= 18;
    }
    ctx.fillText('Hold Tab for scores', WORLD_W - 16, y);
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

    // Rematch countdown: the previous ship is reused unless they repick.
    if (!this.myPick && this.lastPick && this.autoPickAt !== null) {
      const left = Math.max(0, this.autoPickAt - Date.now()) / 1000;
      const barW = 320;
      const y = h * 0.7;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `Sailing the ${this.lastPick} again in ${Math.ceil(left)}s — pick any ship to change`,
        w / 2,
        y - 14,
      );
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(w / 2 - barW / 2, y, barW, 8);
      ctx.fillStyle = '#ffd75e';
      ctx.fillRect(w / 2 - barW / 2, y, barW * (left / AUTO_PICK_AFTER), 8);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '17px system-ui, sans-serif';
    const howToPick = TOUCH ? 'Tap a ship to choose it' : 'Press 1, 2 or 3 to choose your ship';
    if (this.mode.kind === 'solo') {
      ctx.fillText(`${howToPick} — the enemy ship is chosen at random`, w / 2, h * 0.82);
      return;
    }

    ctx.fillText(
      this.myPick ? `You chose the ${this.myPick} ship — waiting for the other captains…` : howToPick,
      w / 2,
      h * 0.82,
    );
    if (this.mode.kind === 'host' && this.slots.length < 2) {
      ctx.fillText(
        `Waiting for players to join — room code ${this.mode.net.code}`,
        w / 2,
        h * 0.82 + 28,
      );
      return;
    }
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

  /** Floating barrels: brown kegs whose warning light blinks faster near the end. */
  private drawMines() {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    const snaps = this.mode.kind === 'guest' ? this.remoteMines : this.mineSnaps();
    for (const mine of snaps) {
      ctx.save();
      ctx.translate(mine.x, mine.y);
      ctx.beginPath();
      ctx.arc(0, 0, MINE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = mine.armed ? '#7a5230' : 'rgba(122, 82, 48, 0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // barrel hoops
      ctx.beginPath();
      ctx.moveTo(-MINE_RADIUS + 1, -2.5);
      ctx.lineTo(MINE_RADIUS - 1, -2.5);
      ctx.moveTo(-MINE_RADIUS + 1, 2.5);
      ctx.lineTo(MINE_RADIUS - 1, 2.5);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // warning light: blinks faster as the fuse burns down
      if (mine.armed && Math.sin(t * (4 + mine.urgency * 14)) > 0) {
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4136';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /** Speech bubbles over the ships of recent talkers. */
  private drawChatBubbles() {
    const ctx = this.ctx;
    const now = Date.now();
    for (const slot of this.slots) {
      const ship = slot.ship;
      if (!ship || ship.sinkProgress >= 1) continue;
      // Bubbles show for the first 4s of a line's 6.5s feed lifetime.
      const line = [...this.chats].reverse().find((c) => c.from === slot.id && now < c.until - 2500);
      if (!line) continue;
      ctx.font = '13px system-ui, sans-serif';
      const w = Math.min(ctx.measureText(line.text).width + 14, 240);
      const x = ship.x;
      const y = ship.y - ship.length / 2 - 26;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 18, w, 22, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 4);
      ctx.lineTo(x + 6, y + 4);
      ctx.lineTo(x, y + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(line.text, x, y - 7, 230);
    }
  }

  /** Recent banter, bottom-left. */
  private drawChatFeed() {
    const ctx = this.ctx;
    const now = Date.now();
    this.chats = this.chats.filter((c) => c.until > now);
    const lines = this.chats.slice(-4);
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    lines.forEach((line, i) => {
      const slot = this.slots.find((s) => s.id === line.from);
      const who = slot ? this.slotLabel(slot) : `Player ${line.from + 1}`;
      const y = WORLD_H - 14 - (lines.length - 1 - i) * 20;
      const text = `${who}: ${line.text}`;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      const w = ctx.measureText(text).width;
      ctx.fillRect(12, y - 16, w + 12, 20);
      ctx.fillStyle = slot ? slot.color : '#fff';
      ctx.fillText(who, 18, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(`: ${line.text}`, 18 + ctx.measureText(who).width, y);
    });
  }

  /** Bottom-center recharge bars for the cannons and the barrel mine. */
  private drawWeaponBars() {
    const ship = this.selfSlot?.ship;
    if (!ship) return;
    const ctx = this.ctx;
    const cx = WORLD_W / 2;
    const y0 = WORLD_H - 40;
    const segW = 26;
    const gap = 4;

    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Cannons: one segment per gun, filling as it reloads.
    const totalW = ship.guns * (segW + gap) - gap;
    const x0 = cx - totalW / 2;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(this.myFireMode === 'volley' ? 'Broadside (F)' : 'Single guns (F)', x0 - 10, y0 + 5);
    ship.gunReload.forEach((r, i) => {
      const frac = 1 - Math.min(r / PLAYER_RELOAD, 1);
      const x = x0 + i * (segW + gap);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x, y0, segW, 10);
      ctx.fillStyle = frac >= 1 ? '#ffd75e' : 'rgba(255, 215, 94, 0.55)';
      ctx.fillRect(x, y0, segW * frac, 10);
    });

    // Barrel mine: a single bar below.
    const cool = this.selfSlot!.mineCool;
    const mineFrac = 1 - Math.min(cool / MINE_RECHARGE, 1);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText('Barrel (S)', x0 - 10, y0 + 21);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(x0, y0 + 16, totalW, 10);
    ctx.fillStyle = mineFrac >= 1 ? '#e8742c' : 'rgba(232, 116, 44, 0.55)';
    ctx.fillRect(x0, y0 + 16, totalW * mineFrac, 10);

    // Sail state, just under the bars.
    ctx.textAlign = 'center';
    ctx.fillStyle = this.myFurled ? '#ffd75e' : 'rgba(255, 255, 255, 0.7)';
    ctx.fillText(this.myFurled ? '⛵ Sails furled — drifting (W)' : '⛵ Sails set (W)', cx, y0 + 34);
  }

  /** Wind dial top-center: an arrow pointing where the wind blows, plus strength. */
  private drawWind() {
    const ctx = this.ctx;
    const cx = WORLD_W / 2;
    const cy = 24;
    const len = 16 + this.wind.strength * 60;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.translate(cx, cy);
    ctx.rotate(this.wind.dir);
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.lineTo(len / 2, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(len / 2 + 7, 0);
    ctx.lineTo(len / 2 - 2, -5);
    ctx.lineTo(len / 2 - 2, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const label =
      this.wind.strength < 0.17 ? 'Light breeze' : this.wind.strength < 0.29 ? 'Steady wind' : 'Strong gale';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(label, cx, cy + 14);
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

  /**
   * The standings panel: everyone ranked by ships sunk. Shown while a player
   * holds Tab (or the mobile 🏆 button), and as the final results on game over.
   */
  private drawScoreboard(final: boolean) {
    const ctx = this.ctx;
    ctx.fillStyle = final ? 'rgba(6, 18, 32, 0.82)' : 'rgba(6, 18, 32, 0.62)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    const ranked = this.slots
      .filter((s) => s.ship || s.score > 0 || !s.left)
      .slice()
      .sort((a, b) => b.score - a.score || (b.ship?.alive ? 1 : 0) - (a.ship?.alive ? 1 : 0));

    const rowH = 30;
    const listH = Math.max(ranked.length, 1) * rowH;
    const top = WORLD_H / 2 - listH / 2;

    // Title.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 38px system-ui, sans-serif';
    let title = 'Scoreboard';
    if (final) {
      const w = this.winner;
      if (this.mode.kind === 'solo') title = w?.id === this.selfId ? 'Enemy ship destroyed!' : 'Your ship was destroyed!';
      else if (!w) title = 'All ships sank!';
      else if (w.id === this.selfId) title = 'Victory!';
      else title = `${this.slotLabel(w)} wins!`;
    }
    ctx.fillText(title, WORLD_W / 2, top - 54);
    if (this.battleMode === 'respawn') {
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.fillText(`First to ${this.target} sinks`, WORLD_W / 2, top - 26);
    }

    // Rows.
    const left = WORLD_W / 2 - 250;
    ranked.forEach((slot, i) => {
      const y = top + i * rowH + rowH / 2;
      const me = slot.id === this.selfId;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = me ? 'bold 17px system-ui, sans-serif' : '17px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(`${i + 1}`, left, y);
      ctx.fillStyle = slot.color;
      ctx.fillRect(left + 26, y - 7, 14, 14);
      ctx.fillStyle = me ? '#ffd75e' : '#fff';
      ctx.fillText(this.slotLabel(slot), left + 50, y);
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText(slot.ship ? slot.ship.type : '—', left + 245, y);
      ctx.textAlign = 'right';
      ctx.font = me ? 'bold 17px system-ui, sans-serif' : '17px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(`${slot.score} sunk`, left + 420, y);
      ctx.textAlign = 'left';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillStyle = slot.ship?.alive ? 'rgba(120, 220, 120, 0.9)' : 'rgba(255, 120, 120, 0.85)';
      ctx.fillText(slot.ship?.alive ? 'afloat' : 'sunk', left + 442, y);
    });

    if (final) {
      ctx.textAlign = 'center';
      ctx.font = '19px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      const again = this.mode.kind === 'solo' ? 'new battle' : 'rematch';
      ctx.fillText(TOUCH ? `Tap the screen for a ${again}` : `Press R for a ${again}`, WORLD_W / 2, top + listH + 36);
    }
  }

  private drawDisconnected() {
    const ctx = this.ctx;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText(this.kicked ? 'Removed by the host' : 'Connection lost', WORLD_W / 2, WORLD_H / 2 - 18);
    ctx.font = '19px system-ui, sans-serif';
    ctx.fillText('Refresh the page to start a new game.', WORLD_W / 2, WORLD_H / 2 + 22);
  }
}
