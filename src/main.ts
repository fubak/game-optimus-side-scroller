/**
 * Entry point.
 *
 * Boots the device and pipeline, then hands control to the game. Anything that
 * can fail (no WebGL2, too few draw buffers, a shader that will not compile) is
 * caught here and reported in the boot overlay rather than leaving a black
 * screen, because a black screen is indistinguishable from a hang.
 */

import { Device, GfxError } from './gfx/device.ts';
import { Pipeline } from './render/pipeline.ts';
import { GameLoop } from './core/loop.ts';
import { VirtualClock, RealClock, type Clock } from './core/time.ts';
import { input } from './core/input.ts';
import { Game } from './game/game.ts';
import { installHarness } from './harness.ts';

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  const bootOverlay = document.getElementById('boot');
  const status = bootOverlay?.querySelector('.status');

  if (!canvas) throw new Error('Canvas element #view is missing');

  const setStatus = (text: string): void => {
    if (status) status.textContent = text;
  };

  const params = new URLSearchParams(location.search);
  const harnessMode = params.get('harness') === '1';

  setStatus('creating device');
  const device = new Device(canvas);

  setStatus('compiling shaders');
  const pipeline = new Pipeline(device);

  setStatus('building world');
  const game = new Game(device, pipeline);
  await game.load();

  // In harness mode the clock only advances when the recorder says so, which
  // is what makes captured footage frame-exact on a machine that renders far
  // slower than real time.
  const clock: Clock = harnessMode ? new VirtualClock() : new RealClock();

  const loop = new GameLoop(
    {
      fixedUpdate: (dt) => game.fixedUpdate(dt, loop.simTime),
      render: (alpha, dt, unscaledDt) => game.render(alpha, dt, unscaledDt),
    },
    clock,
  );

  game.attachLoop(loop);

  const resize = (): void => {
    // Cap the device pixel ratio: rendering a deferred pipeline at 3x on a
    // phone screen costs nine times the fill rate for a difference nobody can
    // see at that physical size.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(window.innerWidth * ratio));
    const height = Math.max(1, Math.floor(window.innerHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    pipeline.resize(width, height);
    game.resize(width, height);
  };
  window.addEventListener('resize', resize);
  resize();

  if (!harnessMode) input.attach();

  if (harnessMode) {
    installHarness({ game, pipeline, device, loop, clock: clock as VirtualClock, canvas });
  }

  bootOverlay?.classList.add('hidden');
  // Remove rather than just hide, so it cannot intercept pointer events.
  setTimeout(() => bootOverlay?.remove(), 600);

  if (!harnessMode) loop.start();

  // Expose for debugging from the console.
  Object.assign(window as unknown as Record<string, unknown>, {
    __game: game,
    __pipeline: pipeline,
    __device: device,
    __loop: loop,
  });
}

boot().catch((error: unknown) => {
  console.error(error);
  const bootOverlay = document.getElementById('boot');
  if (!bootOverlay) return;

  const message =
    error instanceof GfxError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

  bootOverlay.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'mark';
  heading.textContent = 'BOOT FAILURE';
  const detail = document.createElement('div');
  detail.className = 'err';
  detail.textContent = message;
  bootOverlay.append(heading, detail);
  bootOverlay.classList.remove('hidden');

  // The harness polls this to fail a capture loudly instead of silently
  // recording a black screen.
  (window as unknown as Record<string, unknown>).__bootError = message;
});
