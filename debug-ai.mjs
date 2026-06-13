// Hammer the AI island-avoidance: several random layouts x 8 approach angles.
import { chromium } from 'playwright';

const GAME_URL = process.env.GAME_URL || 'http://localhost:4173/';
const browser = await chromium.launch();

let total = 0;
let groundings = 0;
for (let round = 0; round < 6; round++) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(GAME_URL);
  await page.click('#solo-btn');
  await page.waitForSelector('#lobby', { state: 'detached' });
  // Worst case for turning: a slow, sluggish large hull.
  await page.keyboard.down('Digit3');
  await page.waitForTimeout(150);
  await page.keyboard.up('Digit3');
  await page.waitForFunction(() => window.__game.phase === 'battle');

  for (let k = 0; k < 8; k++) {
    await page.evaluate((k) => {
      const g = window.__game;
      g.icebergs = [];
      for (const isl2 of g.islands) delete isl2.pier;
      const isl = g.islands[k % g.islands.length];
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      // Rotate the approach until the spawn spot is on-map and on open
      // water — a teleport into another island (or off-world) is not a
      // steering failure, just a bad test placement.
      let a = (k / 8) * Math.PI * 2;
      for (let j = 0; j < 16; j++) {
        const x = isl.x - Math.cos(a) * 260;
        const y = isl.y - Math.sin(a) * 260;
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
