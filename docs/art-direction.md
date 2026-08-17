# Art direction

## Enhanced (WebGL2): Dead Cells, not Axiom Verge

Enhanced's visual target is **Dead Cells** — smooth HD-2D shading, strong emissive bloom on a
handful of self-lit details (the goal, the visor, energy cells, light shafts), soft deferred
lighting, and readable silhouettes. It is explicitly *not* going for:

- Chunky nearest-neighbour "pixel materials" (the Axiom Verge look) — the material atlas is always
  linear-filtered in Enhanced (`GlWorldRenderer`'s atlas upload), so tiles read as smoothly shaded
  surfaces at any supersampling ratio, not blown-up pixel art.
- A heavy CRT/scanline/chromatic-aberration film filter — grain and chromatic aberration default
  **off** (`DEFAULT_RENDER_SETTINGS` / `QUALITY_PRESETS` in `src/render/settings.ts`), and even when
  a player opts into them the offsets/amplitudes in `post/composite.ts` are deliberately subtle, not
  a "damaged film" effect. Vignette stays on but mild — it frames the viewport, it does not crush
  the edges toward black.

Concretely, that means:

- **Bloom** (`post/bloom.ts`, thresholds/intensity in `GlWorldRenderer`) is tuned for a punchy,
  wide-radius glow on emissive surfaces only — never on ambient/point-lit terrain.
- **Lighting** (`lightingPass.ts`, `lights.ts`) uses a stronger key light with a slightly cool tint
  for rim contrast against warm emissive highlights, plus larger/brighter point lights on the
  player's visor/jetpack and the level goal, without ever pushing albedo to flat white.
- **Tonemap** stays filmic (ACES by default, AgX as an alternative) for punchy highlights without
  clipping.

## Classic (Canvas2D): unchanged, stays chunky

Classic (`ClassicWorldRenderer`, `src/render/renderer.ts`) remains the crisp, flat-painted,
nearest-neighbour pixel-art look it always was. It is the fallback renderer, the `?classic=1` path,
and the basis for the Playwright visual-regression baselines (`tests/e2e/visual.spec.ts`) — none of
the Enhanced-only changes above touch it.

## Where the defaults live

| Concern | File |
| --- | --- |
| Post-processing defaults per quality preset | `src/render/settings.ts` |
| Composite pass (tonemap/vignette/grain/chromatic aberration) | `src/render/gl/post/composite.ts` |
| Bloom thresholds/intensity | `src/render/gl/GlWorldRenderer.ts`, `src/render/gl/post/bloom.ts` |
| Deferred lighting (key light, point lights) | `src/render/gl/lightingPass.ts`, `src/render/gl/lights.ts` |
| Material atlas filtering | `src/render/gl/GlWorldRenderer.ts` (atlas upload), `src/render/gl/materialTextures.ts` |
| Procedural materials (hand-authored panels, 128px tiles) | `src/render/materials/generate.ts` |
| Enhanced parallax / light shafts | `src/render/parallaxEnhanced.ts`, `src/render/gl/backgroundBatch.ts` |
| Soft GPU particles | `src/render/gl/particleBatch.ts`, `GlWorldRenderer.drawParticles` |
| Skeletal animation fluidity | `src/render/rig/optimusRig.ts` |
| Full-res Enhanced HUD/menus | `src/render/uiSpace.ts`, `src/main.ts` |
| Softened tile grid (Enhanced) | `GlWorldRenderer` tile UV bleed + quad overlap |
