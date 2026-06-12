// Smoke test: a 3-player match via the real PeerJS broker, plus rejection of
// duplicate-device and over-capacity joins.
import { chromium } from 'playwright';

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

const host = await newPlayer('host', { width: 1300, height: 760 });
await host.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(GAME_URL).origin });
await host.goto(GAME_URL);
await host.selectOption('#cap-select', '3');
await host.click('#host-btn');
await host.waitForFunction(statusIncludes('Room code'), null, { timeout: 20000 });
const link = await host.inputValue('#share-link');
const clipboard = await host.evaluate(() => navigator.clipboard.readText());
console.log('invite link:', link, '| clipboard matches:', clipboard === link);

const guest1 = await newPlayer('guest1', { width: 1000, height: 700 });
await guest1.goto(link);
await guest1.waitForFunction(statusIncludes('waiting for the host'), null, { timeout: 30000 });
console.log('guest1 joined');

// Same browser (= same device ID) trying to join again must be rejected.
const dupTab = await guest1.context().newPage();
await dupTab.goto(link);
await dupTab.waitForFunction(statusIncludes('already in that game'), null, { timeout: 30000 });
console.log('duplicate-device join rejected ✓');
await dupTab.close();

const guest2 = await newPlayer('guest2', { width: 900, height: 600 });
await guest2.goto(link);
await guest2.waitForFunction(statusIncludes('waiting for the host'), null, { timeout: 30000 });
console.log('guest2 joined');

// Room is now at its cap of 3 — a fourth player must be turned away.
const extra = await newPlayer('extra', { width: 800, height: 600 });
await extra.goto(link);
await extra.waitForFunction(statusIncludes('full'), null, { timeout: 30000 });
console.log('over-capacity join rejected ✓');
await extra.close();

await host.waitForFunction(() => document.getElementById('player-list').textContent.startsWith('3/3'));
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

await browser.close();
console.log('done');
