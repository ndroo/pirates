import { Game, WORLD_H, WORLD_W, type GameMode } from './game';
import { Input } from './input';
import { hostGame, joinGame, type BattleMode } from './net';
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
const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
const ipCheck = document.getElementById('ip-check') as HTMLInputElement;
const shareRow = document.getElementById('share-row') as HTMLDivElement;
const shareLink = document.getElementById('share-link') as HTMLInputElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement;
const waitRoom = document.getElementById('wait-room') as HTMLDivElement;
const playerCount = document.getElementById('player-count') as HTMLParagraphElement;
const playerList = document.getElementById('player-list') as HTMLDivElement;
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
  modeSelect.disabled = busy;
  ipCheck.disabled = busy;
}

function startGame(mode: GameMode): Game {
  lobby.remove();
  const game = new Game(ctx, new Input(), mode);
  (window as { __game?: Game }).__game = game; // for the e2e smoke test
  game.start();
  return game;
}

/** In-game admin controls, shown only on the host's screen. */
function buildHostPanel(game: Game, initialMode: BattleMode) {
  const panel = document.createElement('div');
  panel.id = 'host-panel';
  panel.innerHTML = `
    <button id="panel-toggle">⚙ Host</button>
    <div id="panel-body" hidden>
      <label>Mode
        <select id="panel-mode">
          <option value="elimination">Last ship standing</option>
          <option value="respawn">Respawns</option>
        </select>
      </label>
      <label id="panel-target-row">First to
        <select id="panel-target">
          <option>3</option>
          <option selected>5</option>
          <option>10</option>
        </select>
        sinks
      </label>
      <div id="panel-players"></div>
    </div>`;
  document.body.append(panel);

  const body = panel.querySelector('#panel-body') as HTMLDivElement;
  const modeSel = panel.querySelector('#panel-mode') as HTMLSelectElement;
  const targetSel = panel.querySelector('#panel-target') as HTMLSelectElement;
  const players = panel.querySelector('#panel-players') as HTMLDivElement;
  modeSel.value = initialMode;

  panel.querySelector('#panel-toggle')!.addEventListener('click', () => {
    body.hidden = !body.hidden;
  });

  const applyRules = () => {
    targetSel.disabled = modeSel.value === 'elimination';
    game.setRules(modeSel.value as BattleMode, Number(targetSel.value));
  };
  modeSel.addEventListener('change', applyRules);
  targetSel.addEventListener('change', applyRules);
  targetSel.disabled = modeSel.value === 'elimination';

  const refreshPlayers = () => {
    players.replaceChildren(
      ...game.roster
        .filter((p) => p.id !== 0)
        .map((p) => {
          const row = document.createElement('div');
          row.className = 'player-row';
          const name = document.createElement('span');
          name.textContent = p.label;
          const kick = document.createElement('button');
          kick.textContent = 'Kick';
          kick.className = 'kick-btn';
          kick.dataset.id = String(p.id);
          kick.addEventListener('click', () => game.kickPlayer(p.id));
          row.append(name, kick);
          return row;
        }),
    );
  };
  refreshPlayers();
  setInterval(refreshPlayers, 1000);
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

    const updateRoom = (guestIds: number[]) => {
      playerCount.textContent = `${guestIds.length + 1}/${net.cap} players aboard`;
      startBtn.disabled = guestIds.length < 1;
      playerList.replaceChildren(
        ...guestIds.map((id) => {
          const row = document.createElement('div');
          row.className = 'player-row';
          const name = document.createElement('span');
          name.textContent = `Player ${id + 1}`;
          const kick = document.createElement('button');
          kick.textContent = 'Kick';
          kick.className = 'kick-btn';
          kick.dataset.id = String(id);
          kick.addEventListener('click', () => net.kick(id));
          row.append(name, kick);
          return row;
        }),
      );
    };
    updateRoom(net.guestIds);
    net.onLobbyChange = updateRoom;

    startBtn.addEventListener('click', () => {
      net.markStarted();
      net.broadcast({ t: 'go-select' });
      const game = startGame({ kind: 'host', net, battle: modeSelect.value as BattleMode });
      buildHostPanel(game, modeSelect.value as BattleMode);
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
