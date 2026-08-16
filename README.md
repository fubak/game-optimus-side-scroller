# OPTIMUS — side-scroller

A browser side-scrolling platformer starring **Optimus**, a humanoid factory robot climbing out of a decaying
robotics plant. Built from scratch with TypeScript and Canvas2D: no game engine, no binary art assets — every
sprite, tile and sound is generated in code.

> Status: in active development. See [Roadmap](#roadmap).

## Quick start

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

## Controls

| Action        | Keys                   |
| ------------- | ---------------------- |
| Move          | `A` / `D` or `←` / `→` |
| Jump          | `Space` / `W` / `↑`    |
| Debug overlay | `F3`                   |

More actions (dash, thrust, pause, mute) arrive with the gameplay phases.

## Scripts

| Script                  | What it does                                     |
| ----------------------- | ------------------------------------------------ |
| `npm run dev`           | Vite dev server with hot reload                  |
| `npm run build`         | Production bundle into `dist/`                   |
| `npm run preview`       | Serve the production bundle                      |
| `npm run lint`          | ESLint (type-aware) over the whole repo          |
| `npm run typecheck`     | `tsc --noEmit` with strict settings              |
| `npm test`              | Vitest unit suite                                |
| `npm run test:coverage` | Unit suite with coverage thresholds              |
| `npm run ci`            | lint + typecheck + tests + build (CI equivalent) |

## Design notes

- **Fixed 480×270 internal buffer**, integer-upscaled to the viewport. Crisp pixels, cheap fill-rate, and
  gameplay code never deals with real window sizes (`src/core/canvas.ts`).
- **Fixed-timestep simulation** at 1/60 s with an accumulator and render interpolation. `advance()` and
  `stepFrames()` are wall-clock free, so unit tests and browser smoke tests can drive the game frame-exactly
  (`src/core/loop.ts`).
- **Determinism first.** All randomness flows through a seeded PRNG owned by the world, so the same input tape
  plus the same seed always reproduce the same run — which is what makes the gameplay testable.
- **Simulation is pure, rendering is a read-only view.** Nothing in `src/render/` mutates game state.

## Project layout

```
src/core/     engine primitives: canvas, loop, input, audio, rng, math, storage
src/game/     simulation: tilemap, physics, player, enemies, levels, scenes
src/render/   canvas painting: sprites, tiles, parallax, particles, HUD
tests/unit/   Vitest specs for the pure modules
```

## Roadmap

- [x] Phase 1 — project scaffold, low-res display, fixed-timestep loop
- [ ] Phase 2 — engine core: input, seeded RNG, tile physics, camera
- [ ] Phase 3 — Optimus movement, animation, particles
- [ ] Phase 4 — level parser and the first playable level
- [ ] Phase 5 — enemies, hazards, combat
- [ ] Phase 6 — scenes, HUD, progression, audio, levels 2–3
- [ ] Phase 7 — finale, polish, touch controls, accessibility
- [ ] Phase 8 — browser smoke tests, CI, deploy
- [ ] Phase 9 — docs and demo

## Licence

MIT — see [LICENSE](./LICENSE).
