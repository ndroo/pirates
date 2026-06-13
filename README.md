# Pirates: Naval Combat

A top-down naval combat game for the browser, inspired by the ship battles in
[Sid Meier's Pirates!](https://sidmeierspirates.fandom.com/wiki/Naval_Combat).
Built with HTML5 Canvas and TypeScript — no game framework, no backend, the
whole game runs in the front end. Play solo against the AI, or battle a friend
over the internet with serverless peer-to-peer multiplayer.

## Game modes

- **Single player** — fight the AI captain, as before.
- **Host a multiplayer game** — pick a player cap (2–16) and a battle mode,
  get a 4-letter room code and invite link, watch players file into the
  waiting room, then start the battle. Free-for-all, two rule sets:
  **Last ship standing** (the sunk spectate until the round ends) or
  **Respawns** (sunk ships return after 3 s; first to N sinks wins).
- **Join** — open an invite link or enter the room code, optionally with a
  display name (shown in the waiting room, HUD, ship tags, and win banner).

The host gets an in-game **⚙ Host panel**: pause/resume the battle (or press
`P`) — everyone freezes and sees a "Paused" overlay — switch rules mid-battle
(effective immediately for everyone), and kick players — kicked players see a
notice and their ship sinks in place. The waiting room has kick buttons too.

A host page refresh does **not** kill the room: the room (code + settings) is
kept in `sessionStorage` and re-registered under the same code on reload,
while disconnected guests automatically retry joining for ~30 s. The battle
in progress is lost — everyone lands back at ship select — but the room and
its invite link survive. Since an invite link only encodes the room code, a
link stays valid exactly as long as that room exists: refreshes are fine,
but once the host's tab is closed for good the room is gone and a new
hosting session mints a new code.

Multiplayer is peer-to-peer over WebRTC (via [PeerJS](https://peerjs.com)) in
a star topology. There is no game server to run: PeerJS's free public broker
is used only to exchange connection handshakes, after which all gameplay data
flows directly between browsers. The host's browser is authoritative — it
runs the full simulation and streams state snapshots to every guest each
frame, while guests send back their steering and fire inputs, so no screen
can drift out of sync. The practical ceiling is the host's WebRTC overhead,
hence the cap of 16.

Two protections against one person joining a room multiple times, both
best-effort (airtight identity would need accounts and a server):

- A random **device ID** stored in `localStorage` is sent with every join;
  the host rejects a second join from the same browser. Bypassable via
  incognito or a different browser.
- An optional **"Block same-network joins"** host toggle: the host reads each
  guest's public IP from the WebRTC connection stats and rejects duplicates.
  Stronger, but two legitimate players on the same Wi-Fi share an IP, so it's
  off by default.

Rooms close to new joins once the battle starts; rematches (press `R`) reuse
the same roster. A player who disconnects mid-battle sinks where they sailed.

Note on deploys: the two sides of a room must run the same build. If you
deploy a protocol-changing update while people are mid-game, have everyone
refresh — a guest on the new build can't complete the handshake with a host
still running the old one.

## How to play

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Choose your ship (small / medium / large) — or click/tap a card |
| `←` / `→` or `A` / `D` | Steer left / right |
| `Space` | Fire (full broadside, or one gun per press in rolling mode) |
| `F` | Toggle fire mode: broadside volley ↔ rolling single guns |
| `S` / `↓` | Drop a barrel mine off the stern |
| `Enter` | Open the chat bar (multiplayer) |
| `R` | After a battle ends, return to ship select |

On phones, on-screen buttons cover steering, FIRE, the barrel, the fire-mode
toggle, and chat; ship select and rematches work by tapping. On a rematch
select screen a 10s countdown reuses your previous ship unless you repick.

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
- Broadsides auto-aim at your **nearest** living enemy: the volley fires from
  whichever side of your hull faces them. In free-for-all, every other ship
  is a valid target — there are no teams.
- Multiplayer fleets spawn evenly spaced on a ring around the arena's center,
  each ship heading along the ring.
- Two fire modes (`F`): a full **broadside volley** once every gun is loaded,
  or **rolling fire** — one gun per press, each gun reloading independently.
  Recharge bars for the guns and the barrel sit bottom-center.
- **Barrel mines** (`S`): one afloat at a time, 10s recharge. They arm the
  instant they hit the water (so you can drop one to stop a chaser), drift
  with the wind, and deal 2 damage on contact — to anyone, including the
  dropper, who gets a brief grace to flee their own barrel. Each rolls a
  10–20s fuse: most self-detonate with an area blast; ~25% are duds that
  fizzle out. Cannonballs detonate them harmlessly.
- **Ramming**: burying your bow in another hull costs them half their max
  health (a short immunity stops one collision from landing twice).
- **Icebergs** appear some rounds: only a small tip shows above the surface,
  but the submerged bulk has a much larger strike radius (Titanic-style), so
  you can run into one well before it looks close. A scrape gouges ~40% of
  your max health rather than sinking you outright, with a few seconds'
  immunity to sail clear.
- Some islands sport a **wooden pier**; cannonballs and ships still treat the
  island as its circular landmass.
- Drifting **clouds** float downwind across the arena, dimming the view of
  whatever passes beneath them (the HUD stays clear).
- Cannonballs fly a visible ballistic arc and splash where they land; badly
  hurt ships scorch, tatter, and pour smoke.
- **Banter** (`Enter`): messages relay through the host and appear as speech
  bubbles over the sender's ship plus a feed bottom-left — including over the
  victory banner, for dignified post-battle discussion.
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
test that connects headless browsers through the real PeerJS broker and
exercises the whole multiplayer surface: a 3-way elimination match,
duplicate-device and over-capacity join rejection, player names, respawn
mode (a forced sink, score credit, and respawn), mid-game rule changes,
kicking, and host-refresh room resume. Run it with `npm run preview` serving
`dist/` on port 4173, then `node e2e-test.mjs`.

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
