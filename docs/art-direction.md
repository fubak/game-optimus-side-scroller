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

## Enhanced layers (art quality)

| Layer | Target |
| --- | --- |
| Materials | 128px hand-authored panels, drips, bold hazard (`materials/generate.ts`) |
| Parallax | 6× factory skyline, warm windows, dual haze (`parallaxEnhanced.ts`) |
| Characters | Tesla Optimus sheets + rounded enemy machines (`spritesheet/`, `rig/`) |
| Pickups / FX | Multi-part shapes, bolt halos, full-size dash ghosts (`GlWorldRenderer`) |
| Lighting | Cool key, punchy beacons, atmospheric fog (`lightingPass.ts`, `lights.ts`) |
| HUD | Full-res MSDF + soft chrome bars (`uiSpace.ts`, `hudChrome.ts`) |

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
| Character sprite sheets (Dead Cells–smooth FPS) | `src/render/spritesheet/`, `SpriteGBufferBatch` |
| Skeletal bake source poses | `src/render/rig/optimusRig.ts`, `enemyRigs.ts` |
| Full-res Enhanced HUD/menus | `src/render/uiSpace.ts`, `src/main.ts` |
| Softened tile grid (Enhanced) | `GlWorldRenderer` tile UV bleed + quad overlap |
| Tile silhouette overlays | `GlWorldRenderer.drawTileOverlays` (spikes, conveyors, CP/goal, scenery) |
| Sheet paint wear / hatch | `spritesheet/style.ts` (`applyPanelWear`, `applyHatchStrokes`) |

## Character animation (Enhanced)

Optimus plays **procedural sprite sheets** baked at Enhanced load from a Tesla Optimus Gen 2–inspired
skeletal rig: pearl polymer panels, charcoal joint covers, black face screen with twin status LEDs,
and elliptical limb segments (not chunky armour bricks). The Enhanced visual is ~1.5× the gameplay
hitbox so he reads clearly without swallowing the tile he stands on; left/right facing follows movement (sheet UVs flip —
he is not camera-locked). Soft alpha fringes keep the silhouette smooth at supersampling. Clip rates
stay dense — run 20@20fps, dash @ 30fps — for Dead Cells–smooth motion. Classic (`?classic=1`) is
unchanged and still uses Canvas2D industrial sprites.
Previews: `npm run generate:spritesheets` → `public/generated/spritesheets/`.

## Other Enhanced props

Enemies bake from elliptical factory rigs (wheels, eyes, rotors, cores) and draw ~1.2× hitbox.
Telegraph / sealed-core / dying combat states select alternate sheet clips (no live-rig fallback).
Spike tips, conveyor cleats, checkpoint lamps, goal shafts, and scenery pipes are G-buffer overlays
so hazards and props keep Classic silhouettes. Sheet bake adds procedural panel wear + hatch strokes
under the soft ink fringe. Pickups restore Classic's canister / hex-nut / cross shapes with
emissive accents. Projectiles use a core+halo stack; dash ghosts and jetpack plume match Optimus's
larger visual footprint. Menus/epilogue paint the Tesla polymer Optimus rig on Enhanced
(`drawOptimusEnhanced.ts`); Classic keeps brick sprites.
