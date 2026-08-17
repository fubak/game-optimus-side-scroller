import { createAudio } from './core/audio';
import { createDisplay, INTERNAL_HEIGHT, INTERNAL_WIDTH } from './core/canvas';
import { ALT_BINDINGS, CompositeInput, DEFAULT_BINDINGS, KeyboardInput } from './core/input';
import type { Input } from './core/input';
import { createLoop } from './core/loop';
import type { Loop } from './core/loop';
import { installTestHooks, shouldInstallTestHooks } from './core/testHooks';
import { TouchInput, createTouchLayout, prefersTouchControls } from './core/touch';
import { Game } from './game/game';
import { ALL_LEVELS, LEVELS } from './game/levels/index';
import { createWorldRenderer } from './render/createWorldRenderer';
import { drawTouchControls } from './render/hud';
import { drawTextMsdf } from './render/msdfFont';
import { palette } from './render/palette';
import { drawDamageFeedback, drawScene, drawSceneTransition } from './render/screens';
import {
  applyQualityPreset,
  loadRenderSettings,
  resolveBackendPreference,
  saveRenderSettings,
  withReducedMotion,
  type QualityPreset,
  type RenderSettings,
} from './render/settings';
import { drawText } from './render/text';
import type { DrawTextFn } from './render/text';
import { beginUiSpace, endUiSpace, makeBufferSpaceTextDraw } from './render/uiSpace';
import type { WorldView } from './render/view';

/**
 * Bootstrap: canvas, input, audio, game, renderer, loop.
 *
 * Everything interesting lives in `Game` (simulation + flow) and the renderers (drawing); this file
 * only wires them to the browser and exposes the deterministic test hooks.
 *
 * Query parameters:
 * - `?level=<id>` — start a specific level immediately (including `dev` for the sandbox)
 * - `?autoplay=1` — hand the controls to the autopilot (attract mode / demo recording)
 * - `?seed=<n>` — force the world RNG seed
 * - `?test=1` — install `window.__optimus` test hooks in a production build
 * - `?classic=1` / `?renderer=classic|webgl2|auto` — force a render backend
 */

const host = document.getElementById('app');
if (host === null) {
  throw new Error('Missing #app host element.');
}

function isQualityPreset(value: unknown): value is QualityPreset {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'ultra':
      return true;
    default:
      return false;
  }
}

const params = new URLSearchParams(window.location.search);
const requestedLevel = params.get('level');
const seedParam = params.get('seed');
const autoplay = params.get('autoplay') === '1';

const keyboard = new KeyboardInput(window);
const audio = createAudio();

let renderSettings: RenderSettings = loadRenderSettings(window.localStorage);
// `?quality=<preset>` lets the bench harness (`scripts/bench.ts`) force a preset without needing
// its own localStorage plumbing; it does not persist, matching `?classic=1`/`?renderer=` below.
const qualityParam = params.get('quality');
if (isQualityPreset(qualityParam)) {
  renderSettings = applyQualityPreset(renderSettings, qualityParam);
}
const backendPreference = resolveBackendPreference(window.location.search, renderSettings);

// A level requested by id starts straight away; otherwise the title screen runs the show.
const levelList = requestedLevel === null ? LEVELS : ALL_LEVELS;
const requestedIndex =
  requestedLevel === null ? -1 : levelList.findIndex((level) => level.id === requestedLevel);

const game = new Game({
  storage: window.localStorage,
  audio,
  levels: levelList,
  autoplay,
  ...(requestedIndex >= 0 ? { startLevelIndex: requestedIndex } : {}),
  ...(seedParam === null ? {} : { seed: Number(seedParam) }),
});

game.onBindingsChanged = (altBindings) => {
  keyboard.setBindings(altBindings ? ALT_BINDINGS : DEFAULT_BINDINGS);
};
keyboard.setBindings(game.save.settings.altBindings ? ALT_BINDINGS : DEFAULT_BINDINGS);

// The renderer decides the display mode: Classic always draws at the 480×270 world-view size, so
// it gets the Classic display (fixed buffer, integer CSS scale); WebGL2 supersamples up to the
// device's real resolution, so it gets the Enhanced display (backbuffer sized to the device,
// fractional CSS letterbox). `preference: 'classic'` (including the `?classic=1` shortcut) always
// resolves to the Classic backend here, so it always gets the Classic display too.
let renderer: WorldView = createWorldRenderer({
  world: game.world ?? game.attractWorld,
  preference: backendPreference,
});
const displayMode = renderer.backend === 'webgl2' ? 'enhanced' : 'classic';
const display = createDisplay(host, { mode: displayMode, renderScale: renderSettings.renderScale });
renderer.resize?.(display.bufferWidth, display.bufferHeight);
window.addEventListener('resize', () => {
  renderer.resize?.(display.bufferWidth, display.bufferHeight);
});

/**
 * Touch controls appear only on devices with a coarse pointer (or when forced with `?touch=1`, which
 * is how they get tested in a desktop browser's device emulation).
 */
const touchEnabled = prefersTouchControls() || params.get('touch') === '1';
const touchButtons = createTouchLayout({ viewWidth: INTERNAL_WIDTH, viewHeight: INTERNAL_HEIGHT });
const touch = touchEnabled
  ? new TouchInput({
      buttons: touchButtons,
      toBuffer: (clientX, clientY) => display.clientToBuffer(clientX, clientY),
    })
  : null;
const input: Input = touch === null ? keyboard : new CompositeInput([keyboard, touch]);

if (touch !== null) {
  const canvas = display.canvas;
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (touch.pointerDown(event.pointerId, event.clientX, event.clientY)) {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
      }
      audio.resume();
    },
    { passive: false },
  );
  canvas.addEventListener('pointermove', (event) => {
    touch.pointerMove(event.pointerId, event.clientX, event.clientY);
  });
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    canvas.addEventListener(eventName, (event) => {
      touch.pointerUp(event.pointerId);
    });
  }
  window.addEventListener('blur', () => {
    touch.releaseAllPointers();
  });
}

let debugVisible = false;
let lastRenderAlpha = 0;

/**
 * Raw per-`requestAnimationFrame` wall-clock deltas, for `scripts/bench.ts`'s p50/p95/p99 report.
 * A fixed-size ring buffer written once per real animation frame (see `recordFrameSample` below)
 * so sampling never allocates in the render hot path; `frameSamples()`/`resetFrameSamples()` below
 * are the only places this gets copied out, and both are rare, test-hook-only calls.
 */
const FRAME_SAMPLE_CAPACITY = 4096;
const frameSamples = new Float64Array(FRAME_SAMPLE_CAPACITY);
let frameSampleCount = 0;
let frameSampleCursor = 0;
let lastFrameSampleAtMs: number | null = null;

function recordFrameSample(): void {
  const now = performance.now();
  if (lastFrameSampleAtMs !== null) {
    frameSamples[frameSampleCursor] = now - lastFrameSampleAtMs;
    frameSampleCursor = (frameSampleCursor + 1) % FRAME_SAMPLE_CAPACITY;
    frameSampleCount = Math.min(frameSampleCount + 1, FRAME_SAMPLE_CAPACITY);
  }
  lastFrameSampleAtMs = now;
}

function resetFrameSamples(): void {
  frameSampleCount = 0;
  frameSampleCursor = 0;
  lastFrameSampleAtMs = null;
}

const QUALITY_CYCLE: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

function effectiveRenderSettings(): RenderSettings {
  return game.save.settings.reducedMotion ? withReducedMotion(renderSettings) : renderSettings;
}

function cycleQuality(): void {
  const index = QUALITY_CYCLE.indexOf(renderSettings.quality);
  const next = QUALITY_CYCLE[(index + 1) % QUALITY_CYCLE.length] ?? 'high';
  renderSettings = applyQualityPreset(renderSettings, next);
  saveRenderSettings(window.localStorage, renderSettings);
}

const loop: Loop = createLoop({
  update(dtSec) {
    // Read the debug toggle first: `game.update` consumes the input frame.
    if (keyboard.justPressed('debug')) debugVisible = !debugVisible;
    game.update(dtSec, input);
    const world = game.world ?? game.attractWorld;
    if (world !== null) renderer.trackTrail(world, dtSec);
  },
  render(alpha) {
    recordFrameSample();
    lastRenderAlpha = alpha;
    draw(alpha);
  },
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'F4') {
    event.preventDefault();
    cycleQuality();
  }
  if (event.code === 'F5' && (event.shiftKey || params.get('dev') === '1')) {
    // Shift+F5 toggles Classic ↔ Auto without a full reload of game state.
    event.preventDefault();
    const nextBackend = renderer.backend === 'webgl2' ? 'classic' : 'auto';
    renderSettings = { ...renderSettings, backend: nextBackend };
    saveRenderSettings(window.localStorage, renderSettings);
    renderer.dispose?.();
    renderer = createWorldRenderer({
      world: game.world ?? game.attractWorld,
      preference: nextBackend,
    });
    renderer.resize?.(display.bufferWidth, display.bufferHeight);
  }
});

/**
 * Text renderer for the HUD and screens: razor-sharp MSDF on the Enhanced (WebGL2) backend, the
 * original bitmap font on Classic — matching each backend's own upscaling story. Read from
 * `renderer.backend` (not `display.mode`) so a runtime backend swap (Shift+F5) picks the right
 * renderer immediately, without needing to recreate the display.
 */
function hudTextDraw(): DrawTextFn {
  return renderer.backend === 'webgl2' ? drawTextMsdf : drawText;
}

function draw(alpha = 0): void {
  const { ctx } = display;
  const world = game.showsWorldBehind ? game.world : game.attractWorld;
  if (world !== null) {
    renderer.draw(ctx, world, alpha, effectiveRenderSettings(), game.save.settings.reducedMotion);
  } else {
    ctx.fillStyle = palette.skyTop;
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
  }

  // Enhanced: scale the CTM to the backbuffer and rasterize MSDF at true buffer-pixel size so
  // HUD/menus stay sharp (see `uiSpace.ts`). Classic keeps identity + bitmap font.
  const uiScale = beginUiSpace(ctx, display);
  const textDraw = makeBufferSpaceTextDraw(uiScale, hudTextDraw());
  const enhancedChrome = renderer.backend === 'webgl2';
  if (world !== null && game.showsWorldBehind) {
    game.hud.draw(ctx, world, INTERNAL_WIDTH, textDraw, enhancedChrome);
  }
  drawDamageFeedback(ctx, game);
  drawScene(ctx, game, textDraw, enhancedChrome);
  drawSceneTransition(ctx, game);
  if (touch !== null) {
    drawTouchControls(ctx, touchButtons, touch.activeActions, textDraw);
  }
  if (debugVisible) {
    if (world !== null) renderer.drawDebug(ctx, world);
    drawDebugPanel(ctx, textDraw);
  }
  endUiSpace(ctx, uiScale);
}

function drawDebugPanel(ctx: CanvasRenderingContext2D, textDraw: DrawTextFn): void {
  const { fps, frameTimeMs, updateMs, renderMs, droppedSteps } = loop.metrics;
  const world = game.world ?? game.attractWorld;
  const player = world?.player;
  const gpuMs = renderer.lastGpuMs;
  const lines = [
    `FPS ${fps.toFixed(1)} FRAME ${frameTimeMs.toFixed(2)}MS`,
    `UPD ${updateMs.toFixed(2)}MS REN ${renderMs.toFixed(2)}MS GPU ${gpuMs === null || gpuMs === undefined ? 'N/A' : `${gpuMs.toFixed(2)}MS`}`,
    `ALPHA ${lastRenderAlpha.toFixed(2)}`,
    `REN ${renderer.backend.toUpperCase()} (${display.mode.toUpperCase()}) Q ${renderSettings.quality.toUpperCase()}`,
    `BUF ${String(display.bufferWidth)}x${String(display.bufferHeight)}`,
    `SCENE ${game.scene.name.toUpperCase()} LVL ${String(game.scene.levelIndex + 1)}`,
    player === undefined
      ? 'NO WORLD'
      : `STATE ${player.state.toUpperCase()} GND ${player.isOnGround ? 'Y' : 'N'}`,
    player === undefined ? '' : `POS ${player.body.x.toFixed(1)} ${player.body.y.toFixed(1)}`,
    player === undefined ? '' : `NRG ${player.energy.toFixed(0)} HP ${String(player.health)}`,
    `FX ${String(world?.particles.activeCount ?? 0)} DROP ${String(droppedSteps)}`,
  ];
  ctx.fillStyle = 'rgb(0 0 0 / 0.7)';
  ctx.fillRect(INTERNAL_WIDTH - 150, 32, 146, lines.length * 8 + 6);
  lines.forEach((line, index) => {
    textDraw(ctx, line, INTERNAL_WIDTH - 146, 35 + index * 8, { color: palette.energy, tracking: 0 });
  });
}

// Audio contexts may only start after a gesture, so unlock on the first interaction.
for (const eventName of ['keydown', 'pointerdown', 'touchstart'] as const) {
  window.addEventListener(
    eventName,
    () => {
      audio.resume();
    },
    { once: true, passive: true },
  );
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    loop.stop();
  } else {
    loop.start();
  }
});

if (shouldInstallTestHooks(window.location.search, import.meta.env.DEV)) {
  installTestHooks({
    stepFrames(steps) {
      loop.stepFrames(steps);
      draw();
    },
    frame: () => loop.frame,
    pauseDriver: () => {
      loop.stop();
    },
    resumeDriver: () => {
      loop.start();
    },
    snapshot: () => game.snapshot(),
    metrics: () => loop.metrics,
    frameSamples: () => Array.from(frameSamples.subarray(0, frameSampleCount)),
    resetFrameSamples,
  });
}

display.resize();
renderer.resize?.(display.bufferWidth, display.bufferHeight);
loop.start();
