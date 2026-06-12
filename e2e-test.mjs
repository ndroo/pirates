// Smoke test: a 3-player match via the real PeerJS broker, plus rejection of
// duplicate-device and over-capacity joins.
import { chromium, devices } from 'playwright';

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

// Open an invite link and join, entering a name first when given one.
// (With a previously saved name the page auto-joins and skips the screen.)
async function joinVia(page, link, name) {
  await page.goto(link);
  if (name) await page.fill('#name-input', name).catch(() => {});
  const btn = page.locator('#invite-join-btn');
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}

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
console.log('duplicate-device join rejected ✓');
await dupTab.close();

const guest2 = await newPlayer('guest2', { width: 900, height: 600 });
await joinVia(guest2, link, 'Mary');
await guest2.waitForFunction(statusIncludes('waiting for the host'), null, { timeout: 30000 });
console.log('guest2 joined');

// Room is now at its cap of 3 — a fourth player must be turned away.
const extra = await newPlayer('extra', { width: 800, height: 600 });
await joinVia(extra, link, 'Latecomer');
await extra.waitForFunction(statusIncludes('full'), null, { timeout: 30000 });
console.log('over-capacity join rejected ✓');
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
console.log('player names in roster ✓');

await hold(host2, 'Digit1'); // small ships sink fast
await hold(guest3, 'Digit1');
await host2.waitForTimeout(500);

// Islands and wind: same on both screens.
const hostIslands = await host2.evaluate(() => window.__game.islands);
const guestIslands = await guest3.evaluate(() => window.__game.islands);
if (!hostIslands.length || JSON.stringify(hostIslands) !== JSON.stringify(guestIslands)) {
  throw new Error(`island mismatch: host ${JSON.stringify(hostIslands)} guest ${JSON.stringify(guestIslands)}`);
}
console.log(`islands synced (${hostIslands.length}) ✓`);
const hostWind = await host2.evaluate(() => window.__game.wind);
const guestWind = await guest3.evaluate(() => window.__game.wind);
if (hostWind.strength <= 0 || JSON.stringify(hostWind) !== JSON.stringify(guestWind)) {
  throw new Error(`wind mismatch: host ${JSON.stringify(hostWind)} guest ${JSON.stringify(guestWind)}`);
}
console.log(`wind synced (strength ${hostWind.strength.toFixed(2)}) ✓`);

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
console.log('ship sank on island and respawned ✓');

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
console.log('sunk ship respawned ✓');
await host2.screenshot({ path: 'shot-respawn-battle.png' });

// Host panel: switch the rules to elimination mid-battle...
await host2.click('#panel-toggle');
await host2.screenshot({ path: 'shot-host-panel.png' });
await host2.selectOption('#panel-mode', 'elimination');
await guest3.waitForFunction(() => window.__game.battleMode === 'elimination', null, { timeout: 10000 });
console.log('mid-game rule change reached the guest ✓');

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
console.log('kick: guest notified, ship sunk, roster updated ✓');
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
console.log('host refresh resumed the room; old invite link still valid ✓');

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
console.log('latecomer joined mid-round on all screens ✓');

await early.close();
await late.close();
await hostM.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 20000 });
console.log('empty room returns the host to the pre-game screen ✓');
await hostM.close();

// --- Solo AI seamanship: aim the AI straight at an island (with its ---
// --- prey on the far side, the worst case) and expect it to dodge.  ---
const solo = await newPlayer('solo', { width: 1100, height: 700 });
await solo.goto(GAME_URL);
await solo.click('#solo-btn');
await solo.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });
await hold(solo, 'Digit1');
await solo.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 10000 });

let groundings = 0;
for (let k = 0; k < 8; k++) {
  await solo.evaluate((k) => {
    const g = window.__game;
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
console.log('AI dodged islands 8/8 ✓');

// Wind physics: the same ship covers more water downwind than upwind.
const measure = async (against) => {
  await solo.evaluate((against) => {
    const g = window.__game;
    g.islands = []; // clear water for the measurement (host-side sim only)
    const ship = g.slots[0].ship;
    ship.health = ship.maxHealth;
    ship.x = 640;
    ship.y = 360;
    ship.heading = g.wind.dir + (against ? Math.PI : 0);
    window.__start = { x: ship.x, y: ship.y };
  }, against);
  await solo.waitForTimeout(900);
  return solo.evaluate(() => {
    const ship = window.__game.slots[0].ship;
    return Math.hypot(ship.x - window.__start.x, ship.y - window.__start.y);
  });
};
const downwind = await measure(false);
const upwind = await measure(true);
if (downwind <= upwind * 1.02) throw new Error(`wind has no effect: downwind ${downwind} vs upwind ${upwind}`);
console.log(`wind physics: downwind ${Math.round(downwind)}px vs upwind ${Math.round(upwind)}px ✓`);

// --- Mobile: tap to pick a ship, on-screen buttons steer and fire. ---
const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => console.log('[phone:ERR]', e.message));
await phone.goto(GAME_URL);
await phone.tap('#solo-btn');
await phone.waitForSelector('#lobby', { state: 'detached', timeout: 10000 });

const canvasBox = await phone.locator('canvas').boundingBox();
await phone.tap('canvas', { position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } }); // middle card
await phone.waitForFunction(() => window.__game.phase === 'battle', null, { timeout: 5000 });
console.log('mobile: tapped a ship card into battle ✓');

if (!(await phone.isVisible('#tc-fire'))) throw new Error('touch controls not shown on phone');

await phone.locator('#tc-fire').dispatchEvent('pointerdown');
await phone.waitForTimeout(400);
const fired = await phone.evaluate(() => window.__game.cannonballs.length > 0);
await phone.locator('#tc-fire').dispatchEvent('pointerup');
if (!fired) throw new Error('FIRE button produced no cannonballs');

const h0 = await phone.evaluate(() => window.__game.slots[0].ship.heading);
await phone.locator('#tc-left').dispatchEvent('pointerdown');
await phone.waitForTimeout(500);
const h1 = await phone.evaluate(() => window.__game.slots[0].ship.heading);
await phone.locator('#tc-left').dispatchEvent('pointerup');
if (h1 >= h0) throw new Error(`steer button did not turn the ship (${h0} -> ${h1})`);
console.log('mobile: FIRE and steer buttons work ✓');

// Tap-to-restart from game over.
await phone.evaluate(() => {
  window.__game.slots[1].ship.health = 0; // sink the AI: game over
});
await phone.waitForTimeout(300);
await phone.tap('canvas', { position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
await phone.waitForFunction(() => window.__game.phase === 'select', null, { timeout: 5000 });
console.log('mobile: tap-to-restart works ✓');
await phoneCtx.close();

// --- Invite screen offers a solo escape hatch. ---
const loner = await newPlayer('loner', { width: 1000, height: 700 });
await loner.goto(`${GAME_URL}?join=ZZZZ`);
await loner.click('#invite-solo-btn');
await loner.waitForSelector('#lobby', { state: 'detached', timeout: 5000 });
const cleanUrl = await loner.evaluate(() => location.search);
if (cleanUrl.includes('join')) throw new Error('solo escape left ?join in the URL');
console.log('invite screen solo escape ✓');

await browser.close();
console.log('done');
