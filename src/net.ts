import { Peer, type DataConnection } from 'peerjs';
import type { ShipTypeName, Turn } from './ship';

/** Snapshot of one ship inside a state message. */
export interface ShipSnap {
  id: number;
  x: number;
  y: number;
  heading: number;
  health: number;
  sink: number;
}

/** Initial ship placement sent when a battle starts. */
export interface ShipSpawn {
  id: number;
  type: ShipTypeName;
  x: number;
  y: number;
  heading: number;
}

export type RejectReason = 'full' | 'duplicate' | 'started' | 'same-ip';

export const REJECT_TEXT: Record<RejectReason, string> = {
  full: 'That game is full.',
  duplicate: 'This device is already in that game.',
  started: 'That game has already started.',
  'same-ip': 'Someone on your network is already in that game (the host blocked same-network joins).',
};

export type NetMessage =
  // host → guest
  | { t: 'welcome'; selfId: number; players: number; cap: number }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'lobby'; players: number; cap: number }
  | { t: 'go-select' } // leave the waiting room / start a rematch
  | { t: 'picked'; ready: number; total: number }
  | { t: 'start'; ships: ShipSpawn[] }
  | {
      t: 'state';
      ships: ShipSnap[];
      balls: { x: number; y: number }[];
      boom: { x: number; y: number }[]; // explosions spawned since the last state
    }
  // guest → host
  | { t: 'pick'; ship: ShipTypeName }
  | { t: 'input'; turn: Turn; fire: boolean; restart: boolean };

// Room codes avoid lookalike characters (0/O, 1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
// Namespace our room codes so we don't collide with other apps on the public broker.
const ID_PREFIX = 'pirates-naval-combat-';

const DEVICE_KEY = 'pirates-device-id';

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/**
 * Stable random ID for this browser, used to keep one device from joining a
 * room twice. Best-effort: a different browser or incognito window gets a
 * fresh ID — airtight identity would need accounts and a server.
 */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * The guest's public IP as seen by our WebRTC connection, for the optional
 * same-network block. Best-effort: returns null if the stats don't expose it.
 */
async function remoteIp(conn: DataConnection): Promise<string | null> {
  const pc = conn.peerConnection;
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    let selectedPairId: string | null = null;
    const pairs: any[] = [];
    const candidates = new Map<string, any>();
    stats.forEach((report: any) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      } else if (report.type === 'candidate-pair') {
        pairs.push(report);
      } else if (report.type === 'remote-candidate') {
        candidates.set(report.id, report);
      }
    });
    const pair =
      pairs.find((p) => p.id === selectedPairId) ??
      pairs.find((p) => p.selected) ??
      pairs.find((p) => p.state === 'succeeded' && p.nominated);
    const candidate = pair && candidates.get(pair.remoteCandidateId);
    return candidate?.address ?? candidate?.ip ?? null;
  } catch {
    return null;
  }
}

interface GuestRecord {
  conn: DataConnection;
  deviceId: string;
  ip: string | null;
}

/** The host's end of the room: many guest connections, join vetting. */
export class HostNet {
  readonly code: string;
  readonly cap: number;

  onLobbyChange: (players: number) => void = () => {};
  onGuestLeave: (id: number) => void = () => {}; // fires only after the game starts
  onMessage: (id: number, msg: NetMessage) => void = () => {};

  private blockSameIp: boolean;
  private guests = new Map<number, GuestRecord>();
  private nextId = 1;
  private started = false;

  constructor(peer: Peer, code: string, cap: number, blockSameIp: boolean) {
    this.code = code;
    this.cap = cap;
    this.blockSameIp = blockSameIp;
    peer.on('connection', (conn) => {
      conn.on('open', () => this.vetAndAccept(conn));
    });
    // Losing the broker doesn't break existing P2P links; reconnect so new
    // guests can still find the room.
    peer.on('disconnected', () => peer.reconnect());
  }

  get playerCount(): number {
    return this.guests.size + 1; // guests + the host
  }

  get guestIds(): number[] {
    return [...this.guests.keys()];
  }

  /** Stop admitting new players (the battle is starting). */
  markStarted() {
    this.started = true;
  }

  broadcast(msg: NetMessage) {
    for (const g of this.guests.values()) {
      if (g.conn.open) g.conn.send(msg);
    }
  }

  private async vetAndAccept(conn: DataConnection) {
    const dev = (conn.metadata as { deviceId?: string } | undefined)?.deviceId;
    let ip: string | null = null;

    let reason: RejectReason | null = null;
    if (this.started) reason = 'started';
    else if (this.playerCount >= this.cap) reason = 'full';
    else if (!dev || dev === deviceId() || [...this.guests.values()].some((g) => g.deviceId === dev)) {
      reason = 'duplicate';
    } else if (this.blockSameIp) {
      ip = await remoteIp(conn);
      if (ip && [...this.guests.values()].some((g) => g.ip === ip)) reason = 'same-ip';
    }

    if (reason) {
      conn.send({ t: 'reject', reason } satisfies NetMessage);
      setTimeout(() => conn.close(), 500); // let the reject flush first
      return;
    }

    const id = this.nextId++;
    this.guests.set(id, { conn, deviceId: dev!, ip });
    conn.on('data', (data) => this.onMessage(id, data as NetMessage));
    conn.on('close', () => {
      if (!this.guests.delete(id)) return;
      if (this.started) {
        this.onGuestLeave(id);
      } else {
        this.broadcastLobby();
        this.onLobbyChange(this.playerCount);
      }
    });

    conn.send({ t: 'welcome', selfId: id, players: this.playerCount, cap: this.cap } satisfies NetMessage);
    this.broadcastLobby();
    this.onLobbyChange(this.playerCount);
  }

  private broadcastLobby() {
    if (!this.started) this.broadcast({ t: 'lobby', players: this.playerCount, cap: this.cap });
  }
}

/** A guest's single connection to the host. */
export class GuestNet {
  selfId = -1;
  onMessage: (msg: NetMessage) => void = () => {};
  onClose: () => void = () => {};

  private conn: DataConnection;

  constructor(peer: Peer, conn: DataConnection) {
    this.conn = conn;
    conn.on('data', (data) => this.onMessage(data as NetMessage));
    conn.on('close', () => this.onClose());
    peer.on('error', () => this.onClose());
    peer.on('disconnected', () => peer.reconnect());
  }

  send(msg: NetMessage) {
    if (this.conn.open) this.conn.send(msg);
  }
}

/** Create a room. Resolves once the room is registered with the broker. */
export function hostGame(opts: { cap: number; blockSameIp: boolean }): Promise<HostNet> {
  return new Promise((resolve, reject) => {
    const code = randomCode();
    const peer = new Peer(ID_PREFIX + code);
    peer.on('error', (err) => reject(err));
    peer.on('open', () => resolve(new HostNet(peer, code, opts.cap, opts.blockSameIp)));
  });
}

/** Join a room by code. Resolves once the host accepts us. */
export function joinGame(code: string): Promise<{ net: GuestNet; players: number; cap: number }> {
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    const timer = setTimeout(() => reject(new Error('No response from the host.')), 15000);

    peer.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + code.toUpperCase(), {
        reliable: true,
        metadata: { deviceId: deviceId() },
      });
      const net = new GuestNet(peer, conn);
      net.onMessage = (msg) => {
        clearTimeout(timer);
        if (msg.t === 'welcome') {
          net.selfId = msg.selfId;
          resolve({ net, players: msg.players, cap: msg.cap });
        } else if (msg.t === 'reject') {
          reject(new Error(REJECT_TEXT[msg.reason]));
        }
      };
    });
  });
}
