# Frame-time bench

`npm run bench` measures real-world frame pacing of the Enhanced (WebGL2) renderer across three
viewport sizes standing in for common display resolutions — 1080p (1920×1080), 1440p (2560×1440),
4K (3840×2160) — crossed with three quality presets (`medium`, `high`, `ultra`), and prints
p50/p95/p99 frame times plus average FPS for each of the nine combinations.

```bash
npm run build   # bench measures the production bundle, not the dev server
npm run bench
```

## How it works

- Boots a headless Chromium (Playwright) against `vite preview`, one page reused across all nine
  runs.
- Each run navigates to `?test=1&renderer=webgl2&quality=<preset>&autoplay=1&level=level-1&seed=1234`
  — the deterministic autopilot plays the same fixed path through the level every time, so all
  combinations exercise the same scene.
- Frame times come from `window.__optimus.frameSamples()`, a ring buffer `src/main.ts` fills once
  per real `requestAnimationFrame` tick (see `src/core/testHooks.ts`). These are raw wall-clock
  deltas between renders, not the fixed-timestep simulation rate, so they reflect actual browser
  frame pacing — the same signal a player's monitor would show.
- A 1.5 s warm-up lets shaders/GC settle before `resetFrameSamples()` clears the buffer; a 4 s
  sampling window follows for each of the nine combinations.
- Results print to the console and get written to [`results.json`](./results.json).

## Best-effort by design

This script is **not** part of `npm run ci`. If Chromium is not installed, `dist/` has not been
built, or the preview server fails to start, it prints a `[bench] Skipping — ...` message and exits
`0` rather than failing the caller — frame-time numbers are a development aid, not a merge gate.

## Reading results.json

```json
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "level": "level-1",
  "seed": 1234,
  "warmupMs": 1500,
  "sampleMs": 4000,
  "results": [
    { "resolution": "1080p", "quality": "medium", "samples": 240, "p50": 8.2, "p95": 9.1, "p99": 11.4, "avgFps": 118.3 }
  ]
}
```

Re-run `npm run bench` after any renderer change that could move the needle — new post-processing
passes, particle budgets, or G-buffer layout changes — and compare against the committed baseline.
