import { createDisplay, INTERNAL_HEIGHT, INTERNAL_WIDTH } from './core/canvas';
import { createLoop } from './core/loop';
import type { Loop } from './core/loop';
import { installTestHooks, shouldInstallTestHooks } from './core/testHooks';

const host = document.getElementById('app');
if (host === null) {
  throw new Error('Missing #app host element.');
}

const display = createDisplay(host);
let debugVisible = false;
let elapsedSec = 0;

const loop: Loop = createLoop({
  update(dtSec) {
    elapsedSec += dtSec;
  },
  render() {
    draw();
  },
});

function draw(): void {
  const { ctx } = display;
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  // Placeholder boot screen: replaced by the title scene in a later phase.
  const pulse = 0.5 + 0.5 * Math.sin(elapsedSec * 2);
  ctx.fillStyle = '#141a26';
  for (let x = 0; x < INTERNAL_WIDTH; x += 16) {
    ctx.fillRect(x, INTERNAL_HEIGHT - 32, 15, 32);
  }
  ctx.fillStyle = `rgb(55 201 255 / ${String(0.45 + pulse * 0.55)})`;
  ctx.fillRect(INTERNAL_WIDTH / 2 - 60, INTERNAL_HEIGHT / 2 - 1, 120, 2);

  ctx.font = '16px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d7dce5';
  ctx.fillText('OPTIMUS', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 14);
  ctx.font = '8px ui-monospace, monospace';
  ctx.fillStyle = '#7c879b';
  ctx.fillText('booting systems…', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 + 16);
  ctx.textAlign = 'left';

  if (debugVisible) {
    drawDebugOverlay();
  }
}

function drawDebugOverlay(): void {
  const { ctx, fit } = display;
  const { fps, frameTimeMs, updateMs, renderMs, droppedSteps } = loop.metrics;
  const lines = [
    `fps ${fps.toFixed(1)}  frame ${frameTimeMs.toFixed(2)}ms`,
    `upd ${updateMs.toFixed(2)}ms  ren ${renderMs.toFixed(2)}ms`,
    `step ${String(loop.frame)}  dropped ${String(droppedSteps)}`,
    `scale x${String(fit.scale)}  ${String(fit.width)}x${String(fit.height)}`,
  ];
  ctx.font = '8px ui-monospace, monospace';
  ctx.fillStyle = 'rgb(0 0 0 / 0.6)';
  ctx.fillRect(2, 2, 132, lines.length * 9 + 4);
  ctx.fillStyle = '#8ef2c0';
  lines.forEach((line, index) => {
    ctx.fillText(line, 5, 11 + index * 9);
  });
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'F3') {
    event.preventDefault();
    debugVisible = !debugVisible;
  }
});

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
    snapshot: () => ({ frame: loop.frame, elapsedSec }),
  });
}

display.resize();
loop.start();
