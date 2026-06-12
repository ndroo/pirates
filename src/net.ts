import { Peer, type DataConnection } from 'peerjs';
import type { ShipTypeName, Turn } from './ship';

/** Snapshot of one ship inside a state message. */
export interface ShipSnap {
  x: number;
  y: number;
  heading: number;
  health: number;
  sink: number;
}

export type NetMessage =
  | { t: 'pick'; ship: ShipTypeName }
  | { t: 'input'; turn: Turn; fire: boolean; restart: boolean }
  | { t: 'start'; hostType: ShipTypeName; guestType: ShipTypeName }
  | { t: 'phase'; phase: 'select' }
  | {
      t: 'state';
      ships: [ShipSnap, ShipSnap]; // [host ship, guest ship]
      balls: { x: number; y: number }[];
      boom: { x: number; y: number }[]; // explosions spawned since the last state
    };

// Room codes avoid lookalike characters (0/O, 1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
// Namespace our room codes so we don't collide with other apps on the public broker.
const ID_PREFIX = 'pirates-naval-combat-';

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/** A connected peer-to-peer link to the other player. */
export class Net {
  onMessage: (msg: NetMessage) => void = () => {};
  onClose: () => void = () => {};

  private conn: DataConnection;

  constructor(peer: Peer, conn: DataConnection) {
    this.conn = conn;
    conn.on('data', (data) => this.onMessage(data as NetMessage));
    conn.on('close', () => this.onClose());
    peer.on('error', () => this.onClose());
    // Losing the broker doesn't break the P2P link; reconnect quietly for future use.
    peer.on('disconnected', () => peer.reconnect());
  }

  send(msg: NetMessage) {
    if (this.conn.open) this.conn.send(msg);
  }
}

/**
 * Create a room and wait for a friend to join.
 * `onWaiting` fires with the room code once the room is registered.
 */
export function hostGame(onWaiting: (code: string) => void): Promise<Net> {
  return new Promise((resolve, reject) => {
    const code = randomCode();
    const peer = new Peer(ID_PREFIX + code);

    peer.on('open', () => onWaiting(code));
    peer.on('error', (err) => reject(err));
    peer.on('connection', (conn) => {
      conn.on('open', () => resolve(new Net(peer, conn)));
    });
  });
}

/** Join a friend's room by code. */
export function joinGame(code: string): Promise<Net> {
  return new Promise((resolve, reject) => {
    const peer = new Peer();

    peer.on('error', (err) => reject(err));
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + code.toUpperCase(), { reliable: true });
      conn.on('open', () => resolve(new Net(peer, conn)));
    });
  });
}
