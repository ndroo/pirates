# Pirates: Naval Combat

A top-down naval combat game for the browser, inspired by the ship battles in
[Sid Meier's Pirates!](https://sidmeierspirates.fandom.com/wiki/Naval_Combat).
Built with HTML5 Canvas and TypeScript — no game framework, no backend, the
whole game runs in the front end. Play solo against the AI, or battle a friend
over the internet with serverless peer-to-peer multiplayer.

## Game modes

- **Single player** — fight the AI captain, as before.
- **Host a multiplayer game** — you get a 4-letter room code to share.
- **Join** — enter a friend's room code to connect to their game.

Multiplayer is peer-to-peer over WebRTC (via [PeerJS](https://peerjs.com)).
There is no game server to run: PeerJS's free public broker is used only to
exchange the initial connection handshake, after which all gameplay data flows
directly between the two browsers. The host's browser is authoritative — it
runs the full simulation and streams state snapshots to the guest every frame,
while the guest sends back its steering and fire inputs, so the two screens
can never drift out of sync.

## How to play

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Choose your ship (small / medium / large) |
| `←` / `→` or `A` / `D` | Steer left / right |
| `Space` | Fire a broadside |
| `R` | After a battle ends, return to ship select |

Your ship is always under sail and moves forward on its own — you only steer,
just like in the original Pirates!. Cannons fire a broadside from whichever
side of your hull faces the enemy, and the balls fly **perpendicular to your
heading**, so you have to maneuver to bring your guns to bear. The enemy
captain does the same: it chases you from a distance, then turns sideways to
line up its own broadside.

## Ship types

| Type | Speed | Turning | Guns per broadside | Hits to sink |
| --- | --- | --- | --- | --- |
| Small | fast (110 px/s) | tight | 2 | 3 |
| Medium | steady (80 px/s) | moderate | 3 | 5 |
| Large | slow (55 px/s) | sluggish | 4 | 8 |

Small ships dodge and harass; large ships are slow-turning fortresses that can
delete a small ship with one well-placed volley. The enemy's ship type is
chosen at random each battle. All type stats live in one table
(`SHIP_TYPES` in `src/ship.ts`), so tuning balance is a one-line change.

## Combat details

- Each cannonball is tracked individually: every ball that connects removes
  exactly 1 health and triggers an explosion at the impact point, so partial
  broadside hits deal partial damage.
- Cannonballs have a maximum range (~320 px) and splash harmlessly past it.
- Hit detection tests each ball against the target ship's rotated bounding box.
- The player reloads faster than the enemy (1.4 s vs 2.2 s) to offset the AI's
  perfect aim — it computes the exact firing angle every frame.
- Health bars for both ships sit in the top-right corner, sized to each ship's
  max health.
- A sunk ship fades beneath the waves, then a victory/defeat banner appears.

## Tech stack

- **HTML5 Canvas 2D + TypeScript, no framework.** At this scope (two ships and
  a handful of cannonballs) a game framework or WebGL renderer adds more
  weight than value; plain Canvas easily holds 60 fps and keeps every line of
  game logic understandable.
- **Vite** for the dev server and build. The build output in `dist/` is just
  static HTML, CSS, and JS (~9 KB of game code) that any static host can serve.

## Project structure

```
src/main.ts        entry point: canvas setup/scaling, lobby UI wiring
src/game.ts        game loop, ship select screen, firing, collisions, HUD,
                   solo/host/guest mode logic
src/net.ts         PeerJS wrapper: room codes, connection, message types
src/ship.ts        Ship class + SHIP_TYPES stat table
src/ai.ts          enemy steering and fire decisions
src/cannonball.ts  projectile movement and rendering
src/explosion.ts   impact explosion effect
src/input.ts       keyboard state tracking
```

## Development

```bash
npm install
npm run dev      # dev server with hot reload at http://localhost:5173
npm run build    # type-check and build static files into dist/
```

Requires Node 20.19+ or 22.12+ (Vite 8). `e2e-test.mjs` is a Playwright smoke
test that opens two headless browsers, connects them through the real PeerJS
broker, and plays a few seconds of a match — run it with `npm run preview`
serving `dist/` on port 4173, then `node e2e-test.mjs`.

## Deployment

The repo deploys to GitHub Pages automatically: on every push to `main`, the
workflow in `.github/workflows/deploy.yml` builds the game and publishes
`dist/`. One-time setup in the repo settings: **Settings → Pages → Source →
GitHub Actions**. Vite is configured with a relative `base` (`vite.config.ts`)
so the build works under the `https://<user>.github.io/<repo>/` subpath.

## Roadmap ideas

- Wind direction and sail effects on speed (skipped for now by choice)
- More cannon ammo types (chain shot, grape shot)
- Boarding when ships collide
- Sound effects
