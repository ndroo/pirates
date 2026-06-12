import { Game, WORLD_H, WORLD_W, type GameMode } from './game';
import { Input } from './input';
import { hostGame, joinGame } from './net';
import './style.css';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Fixed logical resolution, scaled to fit the window, so all players see the
// same arena no matter their screen size.
canvas.width = WORLD_W;
canvas.height = WORLD_H;

function resize() {
  const scale = Math.min(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
  canvas.style.width = `${WORLD_W * scale}px`;
  canvas.style.height = `${WORLD_H * scale}px`;
}
resize();
window.addEventListener('resize', resize);

const lobby = document.getElementById('lobby')!;
const status = document.getElementById('lobby-status')!;
const soloBtn = document.getElementById('solo-btn') as HTMLButtonElement;
const hostBtn = document.getElementById('host-btn') as HTMLButtonElement;
const joinBtn = document.getElementById('join-btn') as HTMLButtonElement;
const codeInput = document.getElementById('code-input') as HTMLInputElement;
const capSelect = document.getElementById('cap-select') as HTMLSelectElement;
const ipCheck = document.getElementById('ip-check') as HTMLInputElement;
const shareRow = document.getElementById('share-row') as HTMLDivElement;
const shareLink = document.getElementById('share-link') as HTMLInputElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement;
const waitRoom = document.getElementById('wait-room') as HTMLDivElement;
const playerList = document.getElementById('player-list') as HTMLParagraphElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;

// 2–16 players; beyond that a browser host's WebRTC connections get shaky.
for (let n = 2; n <= 16; n++) {
  const opt = document.createElement('option');
  opt.value = String(n);
  opt.textContent = String(n);
  if (n === 5) opt.selected = true;
  capSelect.append(opt);
}

function setBusy(busy: boolean) {
  soloBtn.disabled = busy;
  hostBtn.disabled = busy;
  joinBtn.disabled = busy;
  codeInput.disabled = busy;
  capSelect.disabled = busy;
  ipCheck.disabled = busy;
}

function startGame(mode: GameMode) {
  lobby.remove();
  new Game(ctx, new Input(), mode).start();
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Could not connect to peer')) return 'No game found with that code.';
  if (msg.includes('is taken')) return 'Room code collision — please try hosting again.';
  return msg.endsWith('.') ? msg : `Connection failed: ${msg}`;
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    copyBtn.textContent = 'Copied!';
  } catch {
    // Clipboard access denied (e.g. Safari outside a click) — select the
    // text so the user can copy it themselves.
    shareLink.focus();
    shareLink.select();
  }
}
copyBtn.addEventListener('click', copyShareLink);

soloBtn.addEventListener('click', () => startGame({ kind: 'solo' }));

hostBtn.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Creating room…';
  try {
    const net = await hostGame({ cap: Number(capSelect.value), blockSameIp: ipCheck.checked });

    shareLink.value = `${location.origin}${location.pathname}?join=${net.code}`;
    shareRow.hidden = false;
    waitRoom.hidden = false;
    status.textContent = `Room code: ${net.code} — send your friends the invite link.`;
    copyShareLink();

    const updateRoom = (players: number) => {
      playerList.textContent = `${players}/${net.cap} players aboard`;
      startBtn.disabled = players < 2;
    };
    updateRoom(net.playerCount);
    net.onLobbyChange = updateRoom;

    startBtn.addEventListener('click', () => {
      net.markStarted();
      net.broadcast({ t: 'go-select' });
      startGame({ kind: 'host', net });
    });
  } catch (err) {
    status.textContent = describeError(err);
    setBusy(false);
  }
});

async function join() {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    status.textContent = 'Enter the 4-letter room code from your friend.';
    return;
  }
  setBusy(true);
  status.textContent = 'Connecting…';
  try {
    const { net, players, cap } = await joinGame(code);
    const waiting = (n: number, c: number) =>
      (status.textContent = `Joined! ${n}/${c} players aboard — waiting for the host to start…`);
    waiting(players, cap);
    net.onMessage = (msg) => {
      if (msg.t === 'lobby') waiting(msg.players, msg.cap);
      else if (msg.t === 'go-select') startGame({ kind: 'guest', net });
    };
    net.onClose = () => {
      status.textContent = 'The host closed the room.';
    };
  } catch (err) {
    status.textContent = describeError(err);
    setBusy(false);
  }
}

joinBtn.addEventListener('click', join);
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

// Opened via an invite link (?join=CODE) — join the friend's game directly.
const inviteCode = new URLSearchParams(location.search).get('join');
if (inviteCode) {
  codeInput.value = inviteCode;
  join();
}
