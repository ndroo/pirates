import { Game, WORLD_H, WORLD_W, type GameMode } from './game';
import { Input } from './input';
import { cleanName, hostGame, joinGame, type BattleMode } from './net';
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
const multiBtn = document.getElementById('multi-btn') as HTMLButtonElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const hostBtn = document.getElementById('host-btn') as HTMLButtonElement;
const joinBtn = document.getElementById('join-btn') as HTMLButtonElement;
const inviteJoinBtn = document.getElementById('invite-join-btn') as HTMLButtonElement;
const codeInput = document.getElementById('code-input') as HTMLInputElement;
const capSelect = document.getElementById('cap-select') as HTMLSelectElement;
const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
const ipCheck = document.getElementById('ip-check') as HTMLInputElement;
const shareLink = document.getElementById('share-link') as HTMLInputElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement;
const playerCount = document.getElementById('player-count') as HTMLParagraphElement;
const playerList = document.getElementById('player-list') as HTMLDivElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const closeRoomBtn = document.getElementById('close-room-btn') as HTMLButtonElement;
const nameInput = document.getElementById('name-input') as HTMLInputElement;
const screenInvite = document.getElementById('screen-invite') as HTMLDivElement;

// The lobby is a stack of screens; show one (or none, status text only).
const screens = [...document.querySelectorAll<HTMLDivElement>('#lobby-panel .screen')];
function showScreen(id: string | null) {
  for (const s of screens) s.hidden = s.id !== id;
}

multiBtn.addEventListener('click', () => showScreen('screen-multi'));
backBtn.addEventListener('click', () => showScreen('screen-home'));

// Remember the player's name across visits, and the host's room across
// refreshes (sessionStorage = this tab only), so a host reload doesn't
// strand the guests: the room comes back under the same code.
const NAME_KEY = 'pirates-name';
const ROOM_KEY = 'pirates-room';
nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
nameInput.addEventListener('change', () => localStorage.setItem(NAME_KEY, cleanName(nameInput.value)));
const myName = () => cleanName(nameInput.value);

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
  multiBtn.disabled = busy;
  hostBtn.disabled = busy;
  joinBtn.disabled = busy;
  inviteJoinBtn.disabled = busy;
  codeInput.disabled = busy;
  capSelect.disabled = busy;
  modeSelect.disabled = busy;
  ipCheck.disabled = busy;
}

function startGame(mode: GameMode): Game {
  lobby.remove();
  const input = new Input();
  enableTouchControls(input);
  const game = new Game(ctx, input, mode);
  (window as { __game?: Game }).__game = game; // for the e2e smoke test
  game.start();
  return game;
}

/** On-screen steer/fire buttons for touch devices, feeding the key state. */
function enableTouchControls(input: Input) {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const controls = document.getElementById('touch-controls') as HTMLDivElement;
  controls.hidden = false;
  const bind = (id: string, code: string) => {
    const el = document.getElementById(id)!;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events have no active pointer; holding still works
      }
      input.press(code);
    });
    for (const ev of ['pointerup', 'pointercancel'] as const) {
      el.addEventListener(ev, () => input.release(code));
    }
  };
  bind('tc-left', 'ArrowLeft');
  bind('tc-right', 'ArrowRight');
  bind('tc-fire', 'Space');
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
    const saved = sessionStorage.getItem(ROOM_KEY);
    if (saved) sessionStorage.setItem(ROOM_KEY, JSON.stringify({ ...JSON.parse(saved), mode: modeSel.value }));
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

async function openRoom(restoreCode?: string) {
  setBusy(true);
  status.textContent = restoreCode ? `Restoring room ${restoreCode}…` : 'Creating room…';
  try {
    const opts = { cap: Number(capSelect.value), blockSameIp: ipCheck.checked, code: restoreCode };
    let net;
    for (let attempt = 1; ; attempt++) {
      try {
        net = await hostGame(opts);
        break;
      } catch (err) {
        // Right after a refresh the broker may briefly still hold our old
        // registration for this code — wait it out.
        const taken = err instanceof Error && err.message.includes('is taken');
        if (!restoreCode || !taken || attempt >= 6) throw err;
        status.textContent = `Restoring room ${restoreCode}… (attempt ${attempt + 1})`;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }

    sessionStorage.setItem(
      ROOM_KEY,
      JSON.stringify({ code: net.code, cap: net.cap, blockSameIp: ipCheck.checked, mode: modeSelect.value }),
    );

    shareLink.value = `${location.origin}${location.pathname}?join=${net.code}`;
    showScreen('screen-wait');
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
          name.textContent = net.guestName(id) || `Player ${id + 1}`;
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
      const game = startGame({ kind: 'host', net, battle: modeSelect.value as BattleMode, name: myName() });
      buildHostPanel(game, modeSelect.value as BattleMode);
    });
  } catch (err) {
    status.textContent = describeError(err);
    setBusy(false);
  }
}

hostBtn.addEventListener('click', () => openRoom());
closeRoomBtn.addEventListener('click', () => {
  sessionStorage.removeItem(ROOM_KEY);
  location.href = location.pathname;
});

async function join(retriesLeft = 0) {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    status.textContent = 'Enter the 4-letter room code from your friend.';
    return;
  }
  setBusy(true);
  if (!retriesLeft) status.textContent = 'Connecting…';
  try {
    const { net, players, cap } = await joinGame(code, myName());
    showScreen(null); // joined: nothing left to configure, status says it all
    const waiting = (n: number, c: number) =>
      (status.textContent = `Joined! ${n}/${c} players aboard — waiting for the host to start…`);
    waiting(players, cap);
    let kicked = false;
    net.onMessage = (msg) => {
      if (msg.t === 'lobby') waiting(msg.players, msg.cap);
      else if (msg.t === 'kicked') {
        kicked = true;
        status.textContent = 'The host removed you from the room.';
      } else if (msg.t === 'go-select') startGame({ kind: 'guest', net, code });
    };
    net.onClose = () => {
      if (kicked) return;
      // Maybe the host is just refreshing — their room code survives that.
      status.textContent = 'Lost the host — reconnecting…';
      setTimeout(() => join(10), 2000);
    };
  } catch (err) {
    if (retriesLeft > 0) {
      status.textContent = `Looking for the room… (${retriesLeft} tries left)`;
      setTimeout(() => join(retriesLeft - 1), 3000);
    } else {
      status.textContent = describeError(err);
      setBusy(false);
    }
  }
}

joinBtn.addEventListener('click', () => join());
inviteJoinBtn.addEventListener('click', () => join());
document.getElementById('invite-solo-btn')!.addEventListener('click', () => {
  history.replaceState(null, '', location.pathname); // drop ?join so a refresh isn't an invite
  startGame({ kind: 'solo' });
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

const params = new URLSearchParams(location.search);
const inviteCode = params.get('join');
const savedRoom = sessionStorage.getItem(ROOM_KEY);
if (inviteCode) {
  // Opened via an invite link (?join=CODE). Join directly when reconnecting
  // (&rejoin=1, set when a game connection drops — keep retrying while the
  // host's room comes back up) or when this player already has a saved name;
  // otherwise show the slim invite screen so they can enter one first.
  codeInput.value = inviteCode;
  if (params.get('rejoin')) {
    showScreen(null);
    join(10);
  } else if (localStorage.getItem(NAME_KEY)) {
    showScreen(null);
    join();
  } else {
    screenInvite.insertBefore(nameInput, inviteJoinBtn);
    showScreen('screen-invite');
    nameInput.focus();
  }
} else if (savedRoom) {
  // This tab was hosting before a refresh — bring the room back under the
  // same code so already-shared invite links keep working.
  try {
    const room = JSON.parse(savedRoom) as { code: string; cap: number; blockSameIp: boolean; mode: string };
    capSelect.value = String(room.cap);
    ipCheck.checked = room.blockSameIp;
    modeSelect.value = room.mode;
    openRoom(room.code);
  } catch {
    sessionStorage.removeItem(ROOM_KEY);
  }
}
