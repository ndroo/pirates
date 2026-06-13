// Smoke test: a 3-player match via the real PeerJS broker, plus rejection of
// duplicate-device and over-capacity joins.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const GAME_URL = process.env.GAME_URL || 'http://localhost:4173/';

const browser = await chromium.launch();

// Each player gets their own browser context = their own localStorage device ID.
async function newPlayer(name, viewport) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  page.on('pageerror', (e) => console.log(`[${name}:ERR]`, e.message));
  return page;
}

const statusIncludes = (text) => `document.getElementById('lobby-status').textContent.includes(${JSON.stringify(text)})`;

// Hold keys ~150ms: the game polls key state once per animation frame.
async function hold(page, key, ms = 150) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Throttled background pages can run animation frames rarely enough that a
// single timed hold falls between frames — press until the game reacts.
async function pressUntil(page, key, predicate, what) {
  for (let i = 0; i < 8; i++) {
    await hold(page, key, 250);
    try {
      await page.waitForFunction(predicate, null, { timeout: 1500, polling: 100 });
      return;
    } catch {
      // not registered yet — press again
    }
  }
  throw new Error(`pressing ${key} never achieved: ${what}`);
}

// Open an invite link and join, entering a name first when given one.
// (With a previously saved name the page auto-joins and skips the screen.)
async function joinVia(page, link, name) {
  await page.goto(link);
  if (name) await page.fill('#name-input', name).catch(() => {});
  const btn = page.locator('#invite-join-btn');
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}

// --- Resumable, streaming runner -----------------------------------------
// Each phase is independent (own browser pages). Passed phases are recorded to
// a checkpoint so a re-run resumes where it stopped. A per-phase watchdog kills
// a hung phase rather than letting it spin forever.
//   E2E_RESET=1   start a clean run (ignore the checkpoint)
//   E2E_ONLY=name run just the phase(s) whose name contains this substring
//   E2E_CKPT=path use a different checkpoint file
const PHASE_NAMES = ['multiplayer', 'midjoin', 'solo', 'mobile', 'invite-escape', 'submarine', 'career'];
const CKPT = process.env.E2E_CKPT || '/tmp/e2e-ckpt.json';
const ONLY = process.env.E2E_ONLY || '';
let donePhases = [];
if (process.env.E2E_RESET) {
  try { fs.unlinkSync(CKPT); } catch {}
} else {
  try { donePhases = JSON.parse(fs.readFileSync(CKPT, 'utf8')); } catch {}
}

const RUN_START = Date.now();
let total = 0; // checks passed across the whole run
let phaseCount = 0; // checks passed in the current phase

// Color only on a real terminal — piped to a log/the chat, stay plain text.
const TTY = process.stdout.isTTY;
const col = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);

/** Record one passing check — counted and grouped under its phase. */
function pass(label) {
  total++;
  phaseCount++;
  console.log(`   ${col('32', '✓')} ${label}`);
}

async function phase(name, fn) {
  const idx = `${PHASE_NAMES.indexOf(name) + 1}/${PHASE_NAMES.length}`;
  if (ONLY && !name.includes(ONLY)) return;
  if (donePhases.includes(name)) {
    console.log(`\n${col('2', `↷ phase ${idx}: ${name} — skipped (already passed)`)}`);
    return;
  }
  phaseCount = 0;
  const start = Date.now();
  console.log(`\n${col('1', `▶ phase ${idx}: ${name}`)}`);
  await Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`watchdog: phase '${name}' exceeded 240s`)), 240000)),
  ]);
  donePhases.push(name);
  fs.writeFileSync(CKPT, JSON.stringify(donePhases));
  console.log(`   ${col('32', `└─ ${phaseCount} checks · ${((Date.now() - start) / 1000).toFixed(0)}s`)}`);
}

try {
await phase('multiplayer', async () => {
const host = await newPlayer('host', { width: 1300, height: 760 });
await host.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(GAME_URL).origin });
await host.goto(GAME_URL);
await host.click('#multi-btn');
await host.selectOption('#cap-select', '3');
await host.click('#host-btn');
await host.waitForFunction(statusIncludes('Room code'), null, { timeout: 20000 });
const link = await host.inputValue('#share-link');
const clipboard = await host.evaluate(() => navigator.clipboard.readText());
console.log('invite link:', link, '| clipboard matches:', clipboard === link);

const guest1 = await newPlayer('guest1', { width: 1000, height: 700 });
await joinVia(guest1, link, 'Anne');
await guest1.waitForFunction(statusIncludes('waiting for the host'), null, { timeout: 30000 });
console.log('guest1 joined');

// Same browser (= same device ID) trying to join again must be rejected.
// guest1's saved name makes this tab auto-join on load.
const dupTab = await guest1.context().newPage();
await dupTab.goto(link);
await dupTab.waitForFunction(statusIncludes('already in that game'), null, { timeout: 30000 });
pass('duplicate-device join rejected');
await dupTab.close();

const guest2 = await newPlayer('guest2', { width: 900, height: 600 });
await joinVia(guest2, link, 'Mary');
await guest2.waitForFunction(statusIncludes('waiting for the host'), null, { timeout: 30000 });
console.log('guest2 joined');

// Room is now at its cap of 3 — a fourth player must be turned away.
const extra = await newPlayer('extra', { width: 800, height: 600 });
await joinVia(extra, link, 'Latecomer');
await extra.waitForFunction(statusIncludes('full'), null, { timeout: 30000 });
pass('over-capacity join rejected');
await extra.close();

await host.waitForFunction(() => document.getElementById('player-count').textContent.startsWith('3/3'));
await host.click('#start-btn');

// Everyone lands on ship select once the host starts.
for (const p of [host, guest1, guest2]) {
  await p.waitForSelector('#lobby', { state: 'detached', timeout: 15000 });
}
console.log('all 3 players in ship select');

await hold(host, 'Digit3');
await hold(guest1, 'Digit1');
await host.waitForTimeout(500);
await host.screenshot({ path: 'shot-select-waiting.png' }); // 2/3 ready
await hold(guest2, 'Digit2');
await host.waitForTimeout(1000);

// Everyone sails and the guests open fire.
await guest1.keyboard.down('ArrowLeft');
await guest1.keyboard.down('Space');
await guest2.keyboard.down('ArrowRight');
await guest2.keyboard.down('Space');
await host.keyboard.down('ArrowLeft');
await host.waitForTimeout(2500);
await host.screenshot({ path: 'shot-host-battle.png' });
await guest2.screenshot({ path: 'shot-guest-battle.png' });
for (const p of [host, guest1, guest2]) await p.close();
console.log('elimination round OK');

// --- Respawn mode: two small ships slug it out until someone sinks, ---
// --- scores a point, and the victim reappears.                      ---
const host2 = await newPlayer('host2', { width: 1300, height: 760 });
await host2.goto(GAME_URL);
await host2.click('#multi-btn');
await host2.fill('#name-input', 'Blackbeard');
await host2.selectOption('#cap-select', '2');
await host2.selectOption('#mode-select', 'respawn');
await host2.click('#host-btn');
await host2.waitForFunction(statusIncludes('Room code'), null, { timeout: 20000 });
const link2 = await host2.inputValue('#share-link');

const guest3 = await newPlayer('guest3', { width: 1000, height: 700 });
await joinVia(guest3, link2, 'Anne');
await host2.waitForFunction(() => document.getElementById('player-count').textContent.startsWith('2/2'));
await host2.click('#start-btn');
for (const p of [host2, guest3]) await p.waitForSelector('#lobby', { state: 'detached', timeout: 15000 });

// Names travel with the join: the host's roster must know the guest as Anne.
const roster = await host2.evaluate(() => window.__game.roster);
if (!roster.some((r) => r.label === 'Anne')) throw new Error(`guest name missing from roster: ${JSON.stringify(roster)}`);
pass('player names in roster');

await hold(host2, 'Digit1'); // small ships sink fast
await hold(guest3, 'Digit1');
await host2.waitForTimeout(500);

// Islands and wind: same on both screens. (Normalize pier null/undefined,
// which the wire serializer doesn't preserve exactly but means the same.)
const islandKey = (page) =>
  page.evaluate(() =>
    JSON.stringify(window.__game.islands.map((i) => [Math.round(i.x), Math.round(i.y), Math.round(i.r), i.pier == null ? -1 : Math.round(i.pier * 100)])),
  );
const hostIslands = await islandKey(host2);
const guestIslands = await islandKey(guest3);
if (hostIslands === '[]' || hostIslands !== guestIslands) {
  throw new Error(`island mismatch: host ${hostIslands} guest ${guestIslands}`);
}
pass(`islands synced`);
const hostWind = await host2.evaluate(() => window.__game.wind);
const guestWind = await guest3.evaluate(() => window.__game.wind);
if (hostWind.strength <= 0 || JSON.stringify(hostWind) !== JSON.stringify(guestWind)) {
  throw new Error(`wind mismatch: host ${JSON.stringify(hostWind)} guest ${JSON.stringify(guestWind)}`);
}
pass(`wind synced (strength ${hostWind.strength.toFixed(2)})`);

// Fire mode opens in broadside (volley), label and behaviour agreeing.
const fm = await host2.evaluate(() => ({ mode: window.__game.myFireMode, slot: window.__game.slots[0].fireMode }));
if (fm.mode !== 'volley' || fm.slot !== 'volley') throw new Error(`battle did not open in broadside: ${JSON.stringify(fm)}`);
pass('battle opens in broadside');

// Clouds are generated and synced (immutable radii match across screens).
const cloudR = (page) => page.evaluate(() => window.__game.clouds.map((c) => Math.round(c.r)).sort((a, b) => a - b));
const hc = await cloudR(host2);
const gc = await cloudR(guest3);
if (!hc.length || JSON.stringify(hc) !== JSON.stringify(gc)) {
  throw new Error(`cloud mismatch: host ${JSON.stringify(hc)} guest ${JSON.stringify(gc)}`);
}
pass(`clouds synced (${hc.length})`);

// Iceberg: scrapes off a chunk of health but does not sink outright.
const berg = await host2.evaluate(() => {
  const g = window.__game;
  const ship = g.slots[0].ship;
  ship.health = ship.maxHealth;
  ship.bergSafe = 0;
  g.icebergs = [{ x: ship.x, y: ship.y, r: 60, hp: 8, maxHp: 8 }]; // tough enough to survive the scrape
  return { max: ship.maxHealth };
});
await host2.waitForFunction(
  (max) => {
    const s = window.__game.slots[0].ship;
    return s.health < max && s.health > 0; // damaged, not sunk
  },
  berg.max,
  { timeout: 4000 },
);
const bergHp = await host2.evaluate(() => window.__game.slots[0].ship.health);
pass(`iceberg scrape: ${berg.max} → ${bergHp} HP, still afloat`);
await host2.evaluate(() => {
  const g = window.__game;
  g.icebergs = [];
  g.slots[0].ship.health = g.slots[0].ship.maxHealth; // patch up for later tests
});

// Running aground must sink the ship on the spot (and respawn it, in this mode).
await host2.evaluate(() => {
  const g = window.__game;
  const isl = g.islands[0];
  const ship = g.slots[0].ship;
  ship.x = isl.x;
  ship.y = isl.y;
});
await host2.waitForFunction(() => !window.__game.slots[0].ship.alive, null, { timeout: 5000 });
await host2.waitForFunction(() => window.__game.slots[0].ship.alive, null, { timeout: 15000 });
pass('ship sank on island and respawned');

// --- Rolling fire: F toggles, one gun per press; the ball splashes. ---
await host2.evaluate(() => {
  const g = window.__game;
  g.islands = []; // open water for the ballistics checks
  const [a, b] = [g.slots[0].ship, g.slots[1].ship];
  a.x = 300; a.y = 360; a.heading = 0;
  b.x = 1000; b.y = 600; // out of cannon range
  g.cannonballs.length = 0;
  g.splashes.length = 0;
});
await host2.bringToFront();
await pressUntil(host2, 'KeyF', () => window.__game.myFireMode === 'rolling', 'rolling mode');
await pressUntil(host2, 'Space', () => window.__game.cannonballs.length > 0, 'a rolling shot');
const ballCount = await host2.evaluate(() => window.__game.cannonballs.length);
if (ballCount !== 1) throw new Error(`rolling fire launched ${ballCount} balls from one press`);
pass('rolling fire: one gun per press');
// The splash is brief (~0.5s), so poll fast to catch it under throttling.
await host2.waitForFunction(() => window.__game.splashes.length > 0, null, { timeout: 8000, polling: 50 });
pass('cannonball splashed into the sea');
await pressUntil(host2, 'KeyF', () => window.__game.myFireMode === 'volley', 'volley mode');

// --- Barrel mines: one afloat at a time, 10s recharge, 2 damage. ---
await pressUntil(host2, 'KeyS', () => window.__game.mines.length === 1, 'a dropped barrel');
// Barrels are live the instant they hit the water now (to stop a chaser).
if (!(await host2.evaluate(() => window.__game.mines[0].armed))) {
  throw new Error('barrel did not arm immediately on drop');
}
pass('barrel arms immediately on drop');
const mineCool = await host2.evaluate(() => window.__game.slots[0].mineCool);
if (mineCool < 8) throw new Error(`mine recharge not engaged (${mineCool})`);
await hold(host2, 'KeyS');
if ((await host2.evaluate(() => window.__game.mines.length)) !== 1) {
  throw new Error('dropped a second barrel while one was afloat');
}
await guest3.waitForFunction(() => window.__game.remoteMines.length === 1, null, { timeout: 5000 });
await host2.evaluate(() => {
  const g = window.__game;
  const mine = g.mines[0];
  const victim = g.slots[1].ship;
  victim.health = victim.maxHealth; // small ship: 3
  victim.x = mine.x;
  victim.y = mine.y;
});
await host2.waitForFunction(
  () => window.__game.mines.length === 0 && window.__game.slots[1].ship.health === 1,
  null, { timeout: 5000 },
);
pass('barrel mine: single stock, recharge, 2 damage on contact');

// --- Ramming: a bow in the hull costs half max health. ---
await host2.evaluate(() => {
  const g = window.__game;
  const [a, b] = [g.slots[0].ship, g.slots[1].ship];
  a.health = a.maxHealth;
  b.health = b.maxHealth;
  b.x = 600; b.y = 400; b.heading = 0;
  a.heading = 0; a.y = 400;
  a.x = 600 - b.length / 2 - a.length / 2 + 8; // bow buried in their stern
});
await host2.waitForFunction(
  () => window.__game.slots[1].ship.health === window.__game.slots[1].ship.maxHealth - Math.ceil(window.__game.slots[1].ship.maxHealth / 2),
  null, { timeout: 3000 },
);
pass('ramming takes half max health');

// --- Solid pier: a ship that hits a jetty (off the island itself) sinks. ---
await host2.evaluate(() => {
  const g = window.__game;
  g.islands = [{ x: 300, y: 300, r: 50, pier: 0, craters: [] }]; // pier along +x
  g.icebergs = [];
  const a = g.slots[0].ship;
  a.health = a.maxHealth;
  a.x = 300 + (50 + 26 + 50 * 0.45) - 8; // on the outboard plank, clear of the land
  a.y = 300;
});
await host2.waitForFunction(() => !window.__game.slots[0].ship.alive, null, { timeout: 4000 });
pass('solid pier sinks a ship');

// --- Cannonballs scar islands (damaged, never destroyed) and the scar syncs. ---
await host2.evaluate(() => {
  const g = window.__game;
  g.islands = [{ x: 400, y: 470, r: 55, craters: [] }];
  g.icebergs = [];
  const a = g.slots[0].ship;
  const b = g.slots[1].ship;
  a.health = a.maxHealth;
  a.x = 400; a.y = 340; a.heading = 0;
  a.gunReload = a.gunReload.map(() => 0);
  b.health = b.maxHealth;
  b.x = 400; b.y = 640; // beyond the island, so the broadside fires through it
  g.cannonballs.length = 0;
});
await host2.bringToFront();
await host2.keyboard.down('Space');
await host2.waitForFunction(() => window.__game.islands[0].craters.length > 0, null, { timeout: 8000, polling: 50 });
await host2.keyboard.up('Space');
pass('cannonball scars the island');
await guest3.waitForFunction(() => (window.__game.islands[0]?.craters?.length ?? 0) > 0, null, { timeout: 5000, polling: 100 });
const islandAlive = await host2.evaluate(() => window.__game.islands.length === 1);
if (!islandAlive) throw new Error('island was destroyed — it should only be scarred');
pass('island scar synced to guest; island survives');

// --- Icebergs shatter under gunfire... ---
await host2.evaluate(() => {
  const g = window.__game;
  g.islands = [];
  g.icebergs = [{ x: 400, y: 470, r: 50, hp: 1, maxHp: 4 }]; // one hit from gone
  const a = g.slots[0].ship;
  a.x = 400; a.y = 340; a.heading = 0;
  a.gunReload = a.gunReload.map(() => 0);
  g.slots[1].ship.x = 400; g.slots[1].ship.y = 640;
  g.cannonballs.length = 0;
});
await host2.keyboard.down('Space');
await host2.waitForFunction(() => window.__game.icebergs.length === 0, null, { timeout: 8000, polling: 50 });
await host2.keyboard.up('Space');
pass('gunfire shatters an iceberg');

// --- ...and under ramming impact (the ship survives the scrape). ---
await host2.evaluate(() => {
  const g = window.__game;
  g.icebergs = [{ x: 300, y: 300, r: 48, hp: 1, maxHp: 4 }];
  const a = g.slots[0].ship;
  a.health = a.maxHealth;
  a.bergSafe = 0;
  a.x = 300; a.y = 300;
});
await host2.waitForFunction(
  () => window.__game.icebergs.length === 0 && window.__game.slots[0].ship.alive,
  null, { timeout: 5000 },
);
pass('ramming shatters an iceberg, ship survives');

// --- Cannon fire blows a pier apart, and that frees the lane on the guest. ---
await host2.evaluate(() => {
  const g = window.__game;
  g.icebergs = [];
  // Pier runs horizontally (+x) across the firing lane, so a broadside gun
  // crosses it regardless of how the guns straddle the hull's centreline.
  g.islands = [{ x: 300, y: 460, r: 55, pier: 0, pierHp: 1, craters: [] }];
  const a = g.slots[0].ship;
  const b = g.slots[1].ship;
  a.health = a.maxHealth;
  a.x = 400; a.y = 300; a.heading = 0;
  a.gunReload = a.gunReload.map(() => 0);
  b.x = 400; b.y = 700; // below, so the broadside fires straight down through the pier
  g.cannonballs.length = 0;
});
await host2.keyboard.down('Space');
await host2.waitForFunction(() => window.__game.islands[0].pier == null, null, { timeout: 9000, polling: 50 });
await host2.keyboard.up('Space');
pass('cannon fire destroys a pier');
await guest3.waitForFunction(() => window.__game.islands[0]?.pier == null, null, { timeout: 5000, polling: 100 });
pass('pier destruction synced to guest');
await host2.evaluate(() => {
  const g = window.__game;
  g.icebergs = [];
  g.islands = [];
  g.slots[0].ship.health = g.slots[0].ship.maxHealth;
});

// --- Banter relays both ways and shows in the feed. ---
await guest3.keyboard.press('Enter');
await guest3.waitForSelector('#chat-bar:not([hidden])', { timeout: 3000 });
await guest3.fill('#chat-input', 'arr, nice shot!');
await guest3.keyboard.press('Enter');
await host2.waitForFunction(
  () => window.__game.chats.some((c) => c.from === 1 && c.text === 'arr, nice shot!'),
  null, { timeout: 5000 },
);
await host2.keyboard.press('Enter');
await host2.waitForSelector('#chat-bar:not([hidden])', { timeout: 3000 });
await host2.fill('#chat-input', 'prepare to be boarded');
await host2.keyboard.press('Enter');
await guest3.waitForFunction(() => window.__game.chats.some((c) => c.from === 0), null, { timeout: 5000 });
pass('banter relayed both ways');

// --- Host pause (via the P key) freezes both screens; resume frees them. ---
await host2.evaluate(() => { window.__game.slots[1].ship.health = window.__game.slots[1].ship.maxHealth; });
await guest3.keyboard.down('ArrowLeft'); // guest tries to turn while paused
await host2.bringToFront();
await host2.keyboard.press('p');
await guest3.waitForFunction(() => window.__game.isPaused, null, { timeout: 5000 });
const frozen = await guest3.evaluate(() => window.__game.slots[1].ship.heading);
await guest3.waitForTimeout(700);
const stillFrozen = await guest3.evaluate(() => window.__game.slots[1].ship.heading);
if (frozen !== stillFrozen) throw new Error('guest ship moved while paused');
pass('host pause (P key) froze the battle on the guest');
await host2.keyboard.press('p');
await guest3.waitForFunction(() => !window.__game.isPaused, null, { timeout: 5000 });
await guest3.waitForFunction((h) => window.__game.slots[1].ship.heading !== h, stillFrozen, { timeout: 5000 });
await guest3.keyboard.up('ArrowLeft');
pass('resume (P key) unfroze the battle');

// --- Drop sail: furled, the ship makes no headway and rides the wind instead. ---
await host2.evaluate(() => {
  const g = window.__game;
  g.islands = []; g.icebergs = [];
  g.wind = { dir: 0, strength: 0.35 }; // strong wind blowing +x
  const a = g.slots[0].ship;
  a.health = a.maxHealth;
  a.x = 200; a.y = 360; a.heading = -Math.PI / 2; // pointing up, across the wind
  window.__sail0 = { x: a.x, y: a.y };
});
await host2.bringToFront();
await pressUntil(host2, 'KeyW', () => window.__game.myFurled === true, 'furled sails');
await host2.waitForTimeout(900);
const drift = await host2.evaluate(() => {
  const a = window.__game.slots[0].ship;
  return { dx: a.x - window.__sail0.x, dy: a.y - window.__sail0.y };
});
// Pointing up but sails down in an eastward wind → drifts mostly +x, not -y.
if (drift.dx < 20 || Math.abs(drift.dy) > Math.abs(drift.dx)) {
  throw new Error(`furled ship did not drift downwind: ${JSON.stringify(drift)}`);
}
pass(`drop sail: drifts downwind ${Math.round(drift.dx)}px, not under power`);
await pressUntil(host2, 'KeyW', () => window.__game.myFurled === false, 'sails reset');

await host2.keyboard.down('Space'); // both auto-aim and blast away
await guest3.keyboard.down('Space');

// Left to sail freely the ships may never meet, so repeatedly drop them
// broadside-to-broadside until someone sinks and credits the shooter.
let scored = false;
for (let i = 0; i < 10 && !scored; i++) {
  await host2.evaluate(() => {
    const g = window.__game;
    const [a, b] = [g.slots[0].ship, g.slots[1].ship];
    // Same heading = zero relative velocity, so the broadsides can't miss.
    // Pick the clearest east-west lane so neither ship runs aground mid-volley.
    if (a?.alive && b?.alive) {
      const clearance = (y) => {
        let worst = Infinity;
        for (let x = 320; x <= 720; x += 40) {
          for (const i of g.islands) {
            worst = Math.min(
              worst,
              Math.hypot(x - i.x, y - i.y) - i.r,
              Math.hypot(x - i.x, y + 80 - i.y) - i.r,
            );
          }
        }
        return worst;
      };
      let bestY = 150;
      let best = -Infinity;
      for (let y = 120; y < 540; y += 20) {
        const c = clearance(y);
        if (c > best) {
          best = c;
          bestY = y;
        }
      }
      a.x = 400; a.y = bestY; a.heading = 0;
      b.x = 400; b.y = bestY + 80; b.heading = 0;
    }
  });
  scored = await host2
    .waitForFunction(() => window.__game.slots.some((s) => s.score >= 1), null, { timeout: 6000, polling: 250 })
    .then(() => true)
    .catch(() => false);
}
if (!scored) throw new Error('no ship sank in the respawn round');
console.log('first sink scored');
// ...the guest's HUD must learn the score...
await guest3.waitForFunction(
  () => window.__game.slots.some((s) => s.score >= 1),
  null, { timeout: 15000, polling: 500 },
);
// ...and the sunk ship must come back while the round is still going.
await host2.waitForFunction(
  () => {
    const g = window.__game;
    return g.phase === 'battle' && g.slots.every((s) => s.ship && s.ship.alive);
  },
  null, { timeout: 30000, polling: 500 },
);
pass('sunk ship respawned');
await host2.screenshot({ path: 'shot-respawn-battle.png' });

// Host panel: switch the rules to elimination mid-battle...
await host2.click('#panel-toggle');
await host2.screenshot({ path: 'shot-host-panel.png' });
await host2.selectOption('#panel-mode', 'elimination');
await guest3.waitForFunction(() => window.__game.battleMode === 'elimination', null, { timeout: 10000 });
pass('mid-game rule change reached the guest');

// ...then kick the guest: they see the notice, their ship sinks for the host.
await host2.click('#panel-players .kick-btn');
await guest3.waitForFunction(() => window.__game.kicked === true, null, { timeout: 10000 });
await host2.waitForFunction(
  () => {
    const g = window.__game;
    return g.roster.length === 1 && !g.slots.find((s) => s.id === 1)?.ship?.alive;
  },
  null, { timeout: 10000 },
);
pass('kick: guest notified, ship sunk, roster updated');
await guest3.screenshot({ path: 'shot-kicked.png' });

// --- Host refresh: the room must come back under the same code, ---
// --- so the previously shared invite link still works.          ---
await host2.reload();
await host2.waitForFunction(statusIncludes('Room code'), null, { timeout: 60000 });
const restoredLink = await host2.inputValue('#share-link');
if (restoredLink !== link2) throw new Error(`room code changed after refresh: ${restoredLink} != ${link2}`);

const guest4 = await newPlayer('guest4', { width: 900, height: 600 });
await joinVia(guest4, link2, 'Calico Jack');
await host2.waitForFunction(() => document.getElementById('player-count').textContent.startsWith('2/2'), null, { timeout: 30000 });
pass('host refresh resumed the room; old invite link still valid');

});

await phase('midjoin', async () => {
// --- Mid-round joins and the empty-room reset. ---
const hostM = await newPlayer('hostM', { width: 1300, height: 760 });
await hostM.goto(GAME_URL);
await hostM.click('#multi-btn');
await hostM.selectOption('#cap-select', '3');
await hostM.click('#host-btn');
await hostM.waitForFunction(statusIncludes('Room code'), null, { timeout: 20000 });
const linkM = await hostM.inputValue('#share-link');

const early = await newPlayer('early', { width: 1000, height: 700 });
await joinVia(early, linkM, 'First');
await hostM.waitForFunction(() => document.getElementById('player-count').textContent.startsWith('2/3'));
await hostM.click('#start-btn');
for (const p of [hostM, early]) await p.waitForSelector('#lobby', { state: 'detached', timeout: 15000 });
await hold(hostM, 'Digit1');
await hold(early, 'Digit1');
await hostM.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 10000 });

const late = await newPlayer('late', { width: 900, height: 600 });
await joinVia(late, linkM, 'Late');
await late.waitForSelector('#lobby', { state: 'detached', timeout: 30000 }); // dropped straight into ship select
await late.waitForFunction(() => window.__game?.phase === 'select', null, { timeout: 10000 });
await hold(late, 'Digit2');
await late.waitForFunction(
  () => window.__game.phase === 'battle' && window.__game.slots.length === 3,
  null, { timeout: 10000 },
);
await hostM.waitForFunction(() => window.__game.slots.filter((s) => s.ship?.alive).length === 3, null, { timeout: 10000 });
await early.waitForFunction(() => window.__game.slots.length === 3, null, { timeout: 10000 });
pass('latecomer joined mid-round on all screens');

await early.close();
await late.close();
await hostM.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 20000 });
pass('empty room returns the host to the pre-game screen');
await hostM.close();

});

await phase('solo', async () => {
// --- Solo AI seamanship: aim the AI straight at an island (with its ---
// --- prey on the far side, the worst case) and expect it to dodge.  ---
const solo = await newPlayer('solo', { width: 1100, height: 700 });
await solo.goto(GAME_URL);
await solo.click('#solo-btn');
await solo.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });
await hold(solo, 'Digit1');
await solo.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 10000 });

// Solo (vs-AI) maps carry no piers (the AI can get trapped on them).
if (await solo.evaluate(() => window.__game.islands.some((i) => i.pier != null))) {
  throw new Error('a solo map generated a pier');
}
pass('solo maps have no piers');

// Nobody spawns inside an iceberg's danger radius.
const safeSpawns = await solo.evaluate(() =>
  window.__game.slots.every((s) =>
    !s.ship || window.__game.icebergs.every((b) => Math.hypot(s.ship.x - b.x, s.ship.y - b.y) > b.r),
  ),
);
if (!safeSpawns) throw new Error('a ship spawned inside an iceberg');
pass('spawns are clear of icebergs');

// Fire mode persists across a rematch (remembered, not reset to broadside).
await pressUntil(solo, 'KeyF', () => window.__game.myFireMode === 'rolling', 'rolling mode');
await solo.evaluate(() => { window.__game.slots[1].ship.health = 0; }); // sink the AI → game over
await solo.waitForFunction(() => window.__game.over, null, { timeout: 4000 });
await hold(solo, 'KeyR'); // rematch
await solo.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 4000 });
await hold(solo, 'Digit2');
await solo.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 4000 });
if (await solo.evaluate(() => window.__game.myFireMode !== 'rolling')) {
  throw new Error('fire mode was not remembered across the rematch');
}
pass('fire mode persists across games');
await pressUntil(solo, 'KeyF', () => window.__game.myFireMode === 'volley', 'reset fire mode');

// Isolate island avoidance: clear the round's random icebergs (a double
// scrape could sink the ship) and piers (a separate hazard, tested above).
await solo.evaluate(() => {
  const g = window.__game;
  g.icebergs = [];
  for (const isl of g.islands) delete isl.pier;
});
let groundings = 0;
for (let k = 0; k < 8; k++) {
  await solo.evaluate((k) => {
    const g = window.__game;
    g.icebergs = []; // stay clear each iteration too
    const isl = g.islands[k % g.islands.length];
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    // Rotate the approach until the spawn spot is on-map and on open water —
    // a teleport into another island (or off-world) is not a steering
    // failure, just a bad test placement.
    let a = (k / 8) * Math.PI * 2;
    for (let j = 0; j < 16; j++) {
      const x = isl.x - Math.cos(a) * 230;
      const y = isl.y - Math.sin(a) * 230;
      const valid =
        x > 30 && x < 1250 && y > 30 && y < 690 &&
        g.islands.every((i) => Math.hypot(x - i.x, y - i.y) > i.r + 70);
      if (valid) break;
      a += Math.PI / 8;
    }
    const ai = g.slots[1].ship;
    const player = g.slots[0].ship;
    ai.health = ai.maxHealth;
    player.health = player.maxHealth;
    ai.x = isl.x - Math.cos(a) * 230;
    ai.y = isl.y - Math.sin(a) * 230;
    ai.heading = a; // bow pointed straight at the island...
    player.x = clamp(isl.x + Math.cos(a) * 330, 30, 1250); // ...and the target beyond it
    player.y = clamp(isl.y + Math.sin(a) * 330, 30, 690);
    g.cannonballs.length = 0;
  }, k);
  await solo.waitForTimeout(3500);
  if (!(await solo.evaluate(() => window.__game.slots[1].ship.alive))) groundings++;
}
if (groundings > 0) throw new Error(`AI ran aground ${groundings}/8 times`);
pass('AI dodged islands 8/8');

// Wind physics: the same ship covers more water downwind than upwind. Step
// the ship's own integrator with a fixed dt so the result can't be skewed by
// real-time frame throttling on a backgrounded page.
const measure = (against) =>
  solo.evaluate((against) => {
    const g = window.__game;
    const ship = g.slots[0].ship;
    ship.health = ship.maxHealth;
    ship.x = 640;
    ship.y = 360;
    ship.heading = g.wind.dir + (against ? Math.PI : 0);
    const wind = { x: Math.cos(g.wind.dir) * g.wind.strength, y: Math.sin(g.wind.dir) * g.wind.strength };
    const x0 = ship.x;
    const y0 = ship.y;
    for (let i = 0; i < 30; i++) ship.update(0.03, 0, 1280, 720, wind, false); // 0.9s, sails set
    return Math.hypot(ship.x - x0, ship.y - y0);
  }, against);
const downwind = await measure(false);
const upwind = await measure(true);
if (downwind <= upwind * 1.02) throw new Error(`wind has no effect: downwind ${downwind} vs upwind ${upwind}`);
pass(`wind physics: downwind ${Math.round(downwind)}px vs upwind ${Math.round(upwind)}px`);

});

await phase('mobile', async () => {
// --- Mobile: tap to pick a ship, on-screen buttons steer and fire. ---
const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => console.log('[phone:ERR]', e.message));
await phone.goto(GAME_URL);
await phone.tap('#solo-btn');
await phone.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });

const canvasBox = await phone.locator('canvas').boundingBox();
// Tap the 2nd card (medium) — world x = WORLD_W/2 - 100 — scaled to the display.
await phone.tap('canvas', {
  position: { x: canvasBox.width * ((1280 / 2 - 100) / 1280), y: canvasBox.height / 2 },
});
await phone.waitForFunction(
  () => window.__game.phase === 'battle' && window.__game.slots[0].ship.type === 'medium',
  null, { timeout: 5000 },
);
pass('mobile: tapped a ship card into battle');

if (!(await phone.isVisible('#tc-fire'))) throw new Error('touch controls not shown on phone');

await phone.locator('#tc-fire').dispatchEvent('pointerdown');
// Poll per frame: a ball can hit an island and despawn within a fixed sleep.
const fired = await phone
  .waitForFunction(() => window.__game.cannonballs.length > 0, null, { timeout: 3000, polling: 'raf' })
  .then(() => true)
  .catch(() => false);
await phone.locator('#tc-fire').dispatchEvent('pointerup');
if (!fired) throw new Error('FIRE button produced no cannonballs');

const h0 = await phone.evaluate(() => window.__game.slots[0].ship.heading);
await phone.locator('#tc-left').dispatchEvent('pointerdown');
await phone.waitForTimeout(500);
const h1 = await phone.evaluate(() => window.__game.slots[0].ship.heading);
await phone.locator('#tc-left').dispatchEvent('pointerup');
if (h1 >= h0) throw new Error(`steer button did not turn the ship (${h0} -> ${h1})`);
pass('mobile: FIRE and steer buttons work');

// Tap-to-restart from game over.
await phone.evaluate(() => {
  window.__game.slots[1].ship.health = 0; // sink the AI: game over
});
await phone.waitForTimeout(300);
await phone.tap('canvas', { position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
await phone.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 5000 });
pass('mobile: tap-to-restart works');

// Rematch select: the countdown reuses the previous ship automatically.
const armed = await phone.evaluate(() => {
  const g = window.__game;
  if (!g.lastPick || !g.autoPickAt) return false;
  g.autoPickAt = Date.now(); // fast-forward the 10s countdown
  return true;
});
if (!armed) throw new Error('rematch auto-pick countdown not armed');
await phone.waitForFunction(
  () => window.__game.phase === 'battle' && window.__game.slots[0].pick === 'medium',
  null, { timeout: 5000 },
);
pass('rematch auto-picked the previous ship');
await phoneCtx.close();

});

await phase('invite-escape', async () => {
// --- Invite screen offers a solo escape hatch. ---
const loner = await newPlayer('loner', { width: 1000, height: 700 });
await loner.goto(`${GAME_URL}?join=ZZZZ`);
await loner.click('#invite-solo-btn');
await loner.waitForSelector('#lobby', { state: 'detached', timeout: 5000 });
const cleanUrl = await loner.evaluate(() => location.search);
if (cleanUrl.includes('join')) throw new Error('solo escape left ?join in the URL');
pass('invite screen solo escape');

});

await phase('submarine', async () => {
// --- Submarine: dives, fires torpedoes by depth, hidden when submerged. ---
const subPage = await newPlayer('sub', { width: 1100, height: 700 });
await subPage.goto(GAME_URL);
await subPage.click('#solo-btn');
await subPage.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });
await subPage.bringToFront();
await hold(subPage, 'Digit4'); // pick the submarine
await subPage.waitForFunction(() => window.__game.phase === 'battle' && window.__game.slots[0].ship.type === 'sub', null, { timeout: 5000 });
if ((await subPage.evaluate(() => window.__game.slots[0].ship.dive)) !== 0) throw new Error('sub did not start surfaced');
pass('submarine selectable, starts surfaced');

// Place the enemy in broadside range below the sub for the firing checks.
await subPage.evaluate(() => {
  const g = window.__game;
  g.islands = []; g.icebergs = [];
  const s = g.slots[0].ship;
  s.x = 400; s.y = 360; s.heading = 0; s.gunReload = s.gunReload.map(() => 0);
  const e = g.slots[1].ship;
  e.x = 400; e.y = 480;
  g.cannonballs.length = 0;
});

// Dive: takes ~3s to submerge.
await hold(subPage, 'KeyE');
await subPage.waitForFunction(() => window.__game.myDive === true, null, { timeout: 3000 });
const t0 = await subPage.evaluate(() => performance.now());
await subPage.waitForFunction(() => window.__game.slots[0].ship.dive >= 1, null, { timeout: 6000, polling: 50 });
const diveMs = (await subPage.evaluate(() => performance.now())) - t0;
if (diveMs < 2200 || diveMs > 4200) throw new Error(`dive took ${Math.round(diveMs)}ms, expected ~3000`);
pass(`submarine dove in ${Math.round(diveMs)}ms`);

// No wake while submerged (slot 0 is the sub; the AI may still wake).
await subPage.evaluate(() => { window.__game.wakes.clear(); });
await subPage.waitForTimeout(400);
if ((await subPage.evaluate(() => window.__game.wakes.get(0)?.length ?? 0)) !== 0) {
  throw new Error('submerged submarine left a wake');
}
pass('submerged sub leaves no wake');

// Submerged, the sub fires an UNDERWATER torpedo, which slides past surface ships.
await subPage.evaluate(() => {
  const g = window.__game;
  g.islands = []; g.icebergs = []; g.torpedoes.length = 0;
  const s = g.slots[0].ship;
  s.x = 250; s.y = 360; s.heading = 0; s.gunReload = s.gunReload.map(() => 0);
  const e = g.slots[1].ship; // surface ship right in the torpedo's path
  e.health = e.maxHealth; e.x = 520; e.y = 360; e.dive = 0;
  window.__surfHp = e.maxHealth;
});
await pressUntil(subPage, 'Space', () => window.__game.torpedoes.length > 0, 'an underwater torpedo');
if (!(await subPage.evaluate(() => window.__game.torpedoes[0].underwater))) {
  throw new Error('submerged sub did not fire an underwater torpedo');
}
pass('submerged sub fires underwater torpedoes');
await subPage.waitForTimeout(1600); // torpedoes run their course past the surface ship
if ((await subPage.evaluate(() => window.__game.slots[1].ship.health)) < (await subPage.evaluate(() => window.__surfHp))) {
  throw new Error('underwater torpedo struck a surface ship');
}
pass('underwater torpedoes pass surface ships');

// Radar sweep paints a sonar contact on the submerged sub.
await subPage.evaluate(() => { window.__game.pings.length = 0; window.__game.pingTimer = 1000; });
await subPage.waitForFunction(() => window.__game.pings.length > 0, null, { timeout: 2000, polling: 50 });
pass('radar ping reveals the submerged sub');

// Depth charges = cannon count, and they hammer a sub at ANY depth (here a
// surfaced one) in the wide blast. Sub far from any surface ship to avoid rams.
await subPage.evaluate(() => {
  const g = window.__game;
  g.myDive = false; g.wind = { dir: 0, strength: 0 };
  const sub = g.slots[0].ship, surf = g.slots[1].ship;
  sub.dive = 0; sub.health = sub.maxHealth; surf.health = surf.maxHealth;
  sub.x = 400; sub.y = 360; surf.x = 1050; surf.y = 600; // surface ship well clear
  window.__hp = { sub: sub.maxHealth, tubes: surf.dcReload.length, guns: surf.guns };
  g.depthCharges.push({ x: 400, y: 360, ownerId: 1, sink: 0.04, spent: false });
});
const meta = await subPage.evaluate(() => window.__hp);
if (meta.tubes !== meta.guns) throw new Error(`depth-charge tubes ${meta.tubes} != cannons ${meta.guns}`);
await subPage.waitForFunction(() => window.__game.depthCharges.length === 0 && window.__game.slots[0].ship.health < window.__hp.sub, null, { timeout: 3000, polling: 50 });
const subDmg = await subPage.evaluate(() => window.__hp.sub - window.__game.slots[0].ship.health);
if (subDmg < 2) throw new Error(`sub took ${subDmg}, expected the full depth-charge hit`);
pass(`depth charges (= cannon count) hit a surfaced sub hard (${subDmg} dmg)`);

// A close surface ship takes a lighter graze from the shockwave (not nothing).
await subPage.evaluate(() => {
  const g = window.__game;
  const sub = g.slots[0].ship, surf = g.slots[1].ship;
  surf.health = surf.maxHealth; surf.x = 400; surf.y = 360;
  sub.x = 1050; sub.y = 600; // sub clear of this one
  window.__sHp = surf.maxHealth;
  g.depthCharges.push({ x: 400, y: 360, ownerId: 0, sink: 0.04, spent: false });
});
await subPage.waitForFunction(() => window.__game.depthCharges.length === 0, null, { timeout: 3000, polling: 50 });
const surfDmg = await subPage.evaluate(() => window.__sHp - window.__game.slots[1].ship.health);
if (surfDmg !== 1) throw new Error(`close surface ship took ${surfDmg}, expected a 1-dmg graze`);
pass(`a close surface ship takes a lighter graze (${surfDmg} dmg)`);

// Submerged, it glides under an iceberg unharmed but still sinks on an island.
await subPage.evaluate(() => {
  const g = window.__game;
  g.myDive = true;
  const s = g.slots[0].ship;
  s.dive = 1; s.health = s.maxHealth; s.bergSafe = 0;
  s.x = 300; s.y = 300;
  g.icebergs = [{ x: 300, y: 300, r: 60, hp: 8, maxHp: 8 }];
});
await subPage.waitForTimeout(500);
if ((await subPage.evaluate(() => window.__game.slots[0].ship.health)) !== (await subPage.evaluate(() => window.__game.slots[0].ship.maxHealth))) {
  throw new Error('submerged sub took iceberg damage');
}
await subPage.evaluate(() => {
  const g = window.__game;
  g.icebergs = [];
  g.islands = [{ x: 300, y: 300, r: 55, craters: [] }];
  const s = g.slots[0].ship; s.x = 300; s.y = 300;
});
await subPage.waitForFunction(() => !window.__game.slots[0].ship.alive, null, { timeout: 3000 });
pass('submerged sub passes under icebergs but sinks on islands');

// Surface the sub (set state directly — no KeyE, which would just toggle it
// back down) and confirm it now fires a SURFACE torpedo, not an underwater one.
await subPage.evaluate(() => {
  const g = window.__game;
  g.myDive = false; // stay up
  g.islands = []; g.icebergs = [];
  const s = g.slots[0].ship;
  s.health = s.maxHealth; s.sinkProgress = 0; s.dive = 0;
  s.x = 250; s.y = 360; s.heading = 0; s.gunReload = s.gunReload.map(() => 0);
  g.torpedoes.length = 0;
});
await pressUntil(subPage, 'Space', () => window.__game.torpedoes.length > 0, 'a surface torpedo');
if (await subPage.evaluate(() => window.__game.torpedoes[0].underwater)) {
  throw new Error('surfaced sub fired an underwater torpedo');
}
pass('surfaced sub fires surface torpedoes');

// Surfaced with the engine cut, the sub drifts on the wind; submerged it holds still.
await subPage.evaluate(() => {
  const g = window.__game;
  g.wind = { dir: 0, strength: 0.35 };
  const s = g.slots[0].ship;
  s.x = 200; s.y = 360; s.dive = 0;
  window.__sx = s.x;
});
await hold(subPage, 'KeyW'); // engine off
await subPage.waitForFunction(() => window.__game.myFurled === true, null, { timeout: 3000 });
await subPage.waitForTimeout(700);
const surfDrift = await subPage.evaluate(() => window.__game.slots[0].ship.x - window.__sx);
if (surfDrift < 20) throw new Error(`surfaced engine-off sub did not drift: ${Math.round(surfDrift)}`);
await subPage.evaluate(() => { const s = window.__game.slots[0].ship; s.dive = 1; s.x = 200; window.__sx = s.x; });
await subPage.waitForTimeout(700);
const subDrift = await subPage.evaluate(() => Math.abs(window.__game.slots[0].ship.x - window.__sx));
if (subDrift > 4) throw new Error(`submerged engine-off sub drifted: ${Math.round(subDrift)}`);
pass('sub drifts surfaced with engine off, holds still submerged');
await subPage.close();

});

await phase('career', async () => {
// --- Scoreboard accumulates a career score across rematches. ---
const careerPage = await newPlayer('career', { width: 1100, height: 700 });
await careerPage.goto(GAME_URL);
await careerPage.click('#solo-btn');
await careerPage.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });
await careerPage.bringToFront();
await hold(careerPage, 'Digit1');
await careerPage.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 5000 });
// Bank a couple of sinks this round, then end it and rematch.
await careerPage.evaluate(() => {
  const g = window.__game;
  g.slots[0].score = 2;
  g.slots[1].ship.health = 0; // sink the AI → game over
});
await careerPage.waitForFunction(() => window.__game.over, null, { timeout: 4000 });
await hold(careerPage, 'KeyR');
await careerPage.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 4000 });
const banked = await careerPage.evaluate(() => window.__game.careerScore.get(0) ?? 0);
if (banked !== 2) throw new Error(`career score not banked across rematch: got ${banked}`);
// New round: a fresh sink should add to the carried-over total.
await hold(careerPage, 'Digit1');
await careerPage.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 5000 });
await careerPage.evaluate(() => { window.__game.slots[0].score = 1; });
const liveTotal = await careerPage.evaluate(() => (window.__game.careerScore.get(0) ?? 0) + window.__game.slots[0].score);
if (liveTotal !== 3) throw new Error(`career total wrong mid-round: got ${liveTotal}, expected 3`);
pass('scoreboard accumulates career score across rematches');
await careerPage.close();
});

  if (!ONLY) { try { fs.unlinkSync(CKPT); } catch {} } // full pass — start fresh next time
  const secs = ((Date.now() - RUN_START) / 1000).toFixed(0);
  console.log(`\n${col('1;32', `✓✓✓  ALL ${total} CHECKS PASSED · ${secs}s  ✓✓✓`)}`);
  console.log('done');
} catch (e) {
  const secs = ((Date.now() - RUN_START) / 1000).toFixed(0);
  console.log(`\n${col('1;31', `✗  FAILED after ${total} checks (${secs}s):`)} ${e && e.message ? e.message : e}`);
  console.log('   re-run to resume from the failed phase · E2E_RESET=1 to start over');
  console.log('FAILED');
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  process.exit(process.exitCode || 0);
}
