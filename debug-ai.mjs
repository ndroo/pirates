// Hammer the AI island-avoidance: several random layouts x 8 approach angles.
import { chromium } from 'playwright';

const GAME_URL = process.env.GAME_URL || 'http://localhost:4173/';
const browser = await chromium.launch();

let total = 0;
let groundings = 0;
for (let round = 0; round < 4; round++) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(GAME_URL);
  await page.click('#solo-btn');
  await page.waitForSelector('#lobby', { state: 'detached' });
  await page.keyboard.down('Digit1');
  await page.waitForTimeout(150);
  await page.keyboard.up('Digit1');
  await page.waitForFunction(() => window.__game.phase === 'battle');

  for (let k = 0; k < 8; k++) {
    await page.evaluate((k) => {
      const g = window.__game;
      const isl = g.islands[k % g.islands.length];
      const a = (k / 8) * Math.PI * 2;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const ai = g.slots[1].ship;
      const player = g.slots[0].ship;
      ai.health = ai.maxHealth;
      player.health = player.maxHealth;
      ai.x = isl.x - Math.cos(a) * 260;
      ai.y = isl.y - Math.sin(a) * 260;
      ai.heading = a;
      player.x = clamp(isl.x + Math.cos(a) * 360, 30, 1250);
      player.y = clamp(isl.y + Math.sin(a) * 360, 30, 690);
      g.cannonballs.length = 0;
    }, k);
    await page.waitForTimeout(3500);
    total++;
    if (!(await page.evaluate(() => window.__game.slots[1].ship.alive))) {
      groundings++;
      const info = await page.evaluate((k) => {
        const g = window.__game;
        const ai = g.slots[1].ship;
        return {
          k,
          angle: ((k / 8) * 360).toFixed(0),
          sankAt: { x: Math.round(ai.x), y: Math.round(ai.y) },
          targetIsland: g.islands[k % g.islands.length],
          islands: g.islands.map((i) => ({ x: Math.round(i.x), y: Math.round(i.y), r: Math.round(i.r) })),
        };
      }, k);
      console.log('GROUNDING:', JSON.stringify(info));
    }
  }
  await page.context().close();
  console.log(`round ${round + 1}: ${groundings}/${total} groundings so far`);
}
await browser.close();
if (groundings > 0) {
  console.log(`FAIL: AI ran aground ${groundings}/${total}`);
  process.exit(1);
}
console.log(`AI clean: 0/${total} groundings`);
