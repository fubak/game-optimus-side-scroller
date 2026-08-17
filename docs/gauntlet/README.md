# 4K visual overhaul — captures & verification

## Artifacts (this agent run)

Captured on the cloud agent at **true 3840×2160** backbuffer (Enhanced) vs Classic 480×270 integer upscale:

| File | Notes |
| --- | --- |
| `before-*-classic.png` | Classic renderer |
| `after-*-enhanced.png` | WebGL2 deferred path at 4K |
| `after-a11y-highcontrast-reduced.png` | High contrast + reduced motion |
| `demo-autopilot-level1-enhanced.webm` | ~45s autopilot playthrough |

Stored under the agent artifacts directory (not committed — PNGs are multi‑MB).

## Reproduce locally

```bash
npm run build
npm run bench          # writes docs/bench/results.json
npx playwright test    # includes Classic visual regression
```

Open Enhanced at native DPR:

```
http://127.0.0.1:4173/?renderer=webgl2
http://127.0.0.1:4173/?classic=1
```

Force a 4K-class backbuffer with a 1920×1080 CSS viewport and `deviceScaleFactor: 2` (Playwright) or a 3840×2160 display.

## Known limits on CI / cloud VMs

`npm run bench` on software WebGL reports low absolute FPS. Treat those numbers as **relative** across quality presets; re-run on discrete GPU hardware for the ≤12 ms @4K budget.
