import { Game, WORLD_H, WORLD_W, type GameMode } from './game';
import { Input } from './input';
import { hostGame, joinGame } from './net';
import './style.css';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Fixed logical resolution, scaled to fit the window, so both players see the
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

function setBusy(busy: boolean) {
  soloBtn.disabled = busy;
  hostBtn.disabled = busy;
  joinBtn.disabled = busy;
  codeInput.disabled = busy;
}

function startGame(mode: GameMode) {
  lobby.remove();
  new Game(ctx, new Input(), mode).start();
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Could not connect to peer')) return 'No game found with that code.';
  if (msg.includes('is taken')) return 'Room code collision — please try hosting again.';
  return `Connection failed: ${msg}`;
}

soloBtn.addEventListener('click', () => startGame({ kind: 'solo' }));

hostBtn.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Creating room…';
  try {
    const net = await hostGame((code) => {
      status.textContent = `Room code: ${code} — share it with your friend and wait here.`;
    });
    startGame({ kind: 'host', net });
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
    startGame({ kind: 'guest', net: await joinGame(code) });
  } catch (err) {
    status.textContent = describeError(err);
    setBusy(false);
  }
}

joinBtn.addEventListener('click', join);
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
