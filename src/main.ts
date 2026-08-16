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
import { drawTouchControls } from './render/hud';
import { palette } from './render/palette';
import { WorldRenderer } from './render/renderer';
import { drawScene } from './render/screens';
import { drawText } from './render/text';

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
 */

const host = document.getElementById('app');
if (host === null) {
  throw new Error('Missing #app host element.');
}

const params = new URLSearchParams(window.location.search);
const requestedLevel = params.get('level');
const seedParam = params.get('seed');
const autoplay = params.get('autoplay') === '1';

const display = createDisplay(host);
const keyboard = new KeyboardInput(window);
const audio = createAudio();

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

const renderer = new WorldRenderer(game.world ?? game.attractWorld);
let debugVisible = false;

const loop: Loop = createLoop({
  update(dtSec) {
    // Read the debug toggle first: `game.update` consumes the input frame.
    if (keyboard.justPressed('debug')) debugVisible = !debugVisible;
    game.update(dtSec, input);
    const world = game.world ?? game.attractWorld;
    if (world !== null) renderer.trackTrail(world, dtSec);
  },
  render() {
    draw();
  },
});

function draw(): void {
  const { ctx } = display;
  const world = game.showsWorldBehind ? game.world : game.attractWorld;
  if (world !== null) {
    renderer.draw(ctx, world);
    if (game.showsWorldBehind) {
      game.hud.draw(ctx, world, INTERNAL_WIDTH);
    }
  } else {
    ctx.fillStyle = palette.skyTop;
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
  }

  drawScene(ctx, game);

  if (touch !== null) {
    drawTouchControls(ctx, touchButtons, touch.activeActions);
  }

  if (debugVisible) {
    if (world !== null) renderer.drawDebug(ctx, world);
    drawDebugPanel(ctx);
  }
}

function drawDebugPanel(ctx: CanvasRenderingContext2D): void {
  const { fps, frameTimeMs, updateMs, renderMs, droppedSteps } = loop.metrics;
  const world = game.world ?? game.attractWorld;
  const player = world?.player;
  const lines = [
    `FPS ${fps.toFixed(1)} FRAME ${frameTimeMs.toFixed(2)}MS`,
    `UPD ${updateMs.toFixed(2)}MS REN ${renderMs.toFixed(2)}MS`,
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
    drawText(ctx, line, INTERNAL_WIDTH - 146, 35 + index * 8, { color: palette.energy, tracking: 0 });
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
  });
}

display.resize();
loop.start();
