// Smoke test: two browsers play a multiplayer match via the real PeerJS broker.
import { chromium } from 'playwright';

const GAME_URL = process.env.GAME_URL || 'http://localhost:4173/';

const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(GAME_URL).origin });
const host = await context.newPage();
await host.setViewportSize({ width: 1300, height: 760 });
const guest = await context.newPage();
await guest.setViewportSize({ width: 900, height: 600 });

host.on('console', (m) => console.log('[host]', m.text()));
guest.on('console', (m) => console.log('[guest]', m.text()));
host.on('pageerror', (e) => console.log('[host:ERR]', e.message));
guest.on('pageerror', (e) => console.log('[guest:ERR]', e.message));

await host.goto(GAME_URL);

await host.click('#host-btn');
await host.waitForFunction(() => document.getElementById('lobby-status').textContent.includes('Room code'), null, { timeout: 20000 });
const link = await host.inputValue('#share-link');
const clipboard = await host.evaluate(() => navigator.clipboard.readText());
console.log('invite link:', link, '| clipboard matches:', clipboard === link);

// Guest joins via the invite link — no code entry needed.
await guest.goto(link);

// Lobby is removed only once the P2P data channel opens on each side.
await host.waitForSelector('#lobby', { state: 'detached', timeout: 30000 });
await guest.waitForSelector('#lobby', { state: 'detached', timeout: 30000 });
console.log('P2P connected: both lobbies closed');

// Hold keys ~150ms: the game polls key state once per animation frame.
async function hold(page, key, ms = 150) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Host picks before guest — exercises the "waiting for friend" path.
await hold(host, 'Digit3');
await host.waitForTimeout(700);
await host.screenshot({ path: 'shot-host-waiting.png' });

await hold(guest, 'Digit1');
await guest.waitForTimeout(1000);

// Guest sails and fires; host turns the other way.
await guest.keyboard.down('ArrowLeft');
await guest.keyboard.down('Space');
await host.keyboard.down('ArrowRight');
await host.waitForTimeout(2500);
await host.screenshot({ path: 'shot-host-battle.png' });
await guest.screenshot({ path: 'shot-guest-battle.png' });

await browser.close();
console.log('done');
