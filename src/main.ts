import { createDisplay, INTERNAL_HEIGHT, INTERNAL_WIDTH } from './core/canvas';
import { KeyboardInput } from './core/input';
import { createLoop } from './core/loop';
import type { Loop } from './core/loop';
import { installTestHooks, shouldInstallTestHooks } from './core/testHooks';
import { parseLevel } from './game/levelParser';
import type { LevelDef } from './game/levelParser';
import { LEVEL_1 } from './game/levels/level1';
import { DEV_PLAYGROUND_LEVEL } from './game/levels/dev';
import { World } from './game/world';
import type { WorldEvent } from './game/world';
import { Hud } from './render/hud';
import { palette } from './render/palette';
import { WorldRenderer } from './render/renderer';
import { drawText } from './render/text';

/**
 * Bootstrap.
 *
 * Builds a level, a world and a renderer, then drives them from the fixed-step loop. Scene flow
 * (title, pause, level select) arrives in a later phase; for now the chosen level starts straight
 * away, selectable with `?level=dev` for the movement sandbox.
 */

const host = document.getElementById('app');
if (host === null) {
  throw new Error('Missing #app host element.');
}

const LEVELS: Readonly<Record<string, LevelDef>> = {
  'level-1': LEVEL_1,
  dev: DEV_PLAYGROUND_LEVEL,
};

const params = new URLSearchParams(window.location.search);
const requestedLevel = params.get('level') ?? 'level-1';
const levelDef = LEVELS[requestedLevel] ?? LEVEL_1;
const seedParam = params.get('seed');

const display = createDisplay(host);
const input = new KeyboardInput(window);
const hud = new Hud();

const level = parseLevel(levelDef);
const world = new World(level, seedParam === null ? {} : { seed: Number(seedParam) });
const renderer = new WorldRenderer(world);

let debugVisible = false;
let introTimer = 2.4;

const loop: Loop = createLoop({
  update(dtSec) {
    const events = world.update(dtSec, input);
    handleEvents(events);
    renderer.trackTrail(world, dtSec);
    hud.update(dtSec);
    introTimer = Math.max(0, introTimer - dtSec);
    if (input.justPressed('debug')) debugVisible = !debugVisible;
    input.endFrame();
  },
  render() {
    draw();
  },
});

function handleEvents(events: readonly WorldEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'pickup':
        hud.push(
          event.kind === 'repairKit' ? 'REPAIRED +1♥' : `+${String(event.score)}`,
          event.kind === 'repairKit' ? palette.health : palette.energy,
          1.1,
        );
        break;
      case 'checkpoint':
        hud.push('CHECKPOINT SYNCED', palette.visor);
        break;
      case 'death':
        hud.push(`SYSTEMS OFFLINE — ${String(event.livesLeft)} LEFT`, palette.hazard, 2);
        break;
      case 'respawn':
        hud.clear();
        break;
      case 'goal':
        hud.push('EXTRACTION COMPLETE', palette.energy, 4);
        break;
      case 'failed':
        hud.push('OUT OF CHASSIS', palette.hazard, 6);
        break;
      case 'enemyKilled':
        hud.push(`SCRAPPED +${String(event.score)}`, palette.uiWarn, 1.1);
        break;
      case 'player':
      case 'enemyShot':
      case 'crusherSlam':
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled world event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function draw(): void {
  const { ctx } = display;
  renderer.draw(ctx, world);
  hud.draw(ctx, world, INTERNAL_WIDTH);

  if (introTimer > 0) {
    drawIntroCard(ctx);
  }
  if (world.status === 'complete') {
    drawBanner(ctx, 'EXTRACTION COMPLETE', palette.energy);
  } else if (world.status === 'failed') {
    drawBanner(ctx, 'OUT OF CHASSIS', palette.hazard);
  }
  if (debugVisible) {
    renderer.drawDebug(ctx, world);
    drawDebugPanel(ctx);
  }
}

function drawIntroCard(ctx: CanvasRenderingContext2D): void {
  const fade = Math.min(1, introTimer / 0.5);
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgb(5 7 12 / 0.72)';
  ctx.fillRect(0, INTERNAL_HEIGHT / 2 - 26, INTERNAL_WIDTH, 52);
  drawText(ctx, level.name, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 16, {
    color: palette.uiText,
    align: 'center',
    scale: 2,
  });
  drawText(ctx, level.subtitle, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 + 6, {
    color: palette.uiDim,
    align: 'center',
  });
  drawText(
    ctx,
    '← → MOVE   SPACE JUMP / HOLD TO FLY   SHIFT DASH',
    INTERNAL_WIDTH / 2,
    INTERNAL_HEIGHT / 2 + 16,
    {
      color: palette.visor,
      align: 'center',
    },
  );
  ctx.globalAlpha = 1;
}

function drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string): void {
  ctx.fillStyle = 'rgb(5 7 12 / 0.6)';
  ctx.fillRect(0, INTERNAL_HEIGHT / 2 - 14, INTERNAL_WIDTH, 28);
  drawText(ctx, text, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 4, {
    color,
    align: 'center',
    scale: 2,
  });
}

function drawDebugPanel(ctx: CanvasRenderingContext2D): void {
  const { fps, frameTimeMs, updateMs, renderMs } = loop.metrics;
  const { player } = world;
  const lines = [
    `FPS ${fps.toFixed(1)} FRAME ${frameTimeMs.toFixed(2)}MS`,
    `UPD ${updateMs.toFixed(2)}MS REN ${renderMs.toFixed(2)}MS`,
    `STATE ${player.state.toUpperCase()} GND ${player.isOnGround ? 'Y' : 'N'}`,
    `POS ${player.body.x.toFixed(1)} ${player.body.y.toFixed(1)}`,
    `VEL ${player.body.vx.toFixed(1)} ${player.body.vy.toFixed(1)}`,
    `NRG ${player.energy.toFixed(0)} DASH ${(player.dashCharge * 100).toFixed(0)}%`,
    `FX ${String(world.particles.activeCount)} STEP ${String(loop.frame)}`,
  ];
  ctx.fillStyle = 'rgb(0 0 0 / 0.7)';
  ctx.fillRect(INTERNAL_WIDTH - 148, 32, 144, lines.length * 8 + 6);
  lines.forEach((line, index) => {
    drawText(ctx, line, INTERNAL_WIDTH - 144, 35 + index * 8, { color: palette.energy, tracking: 0 });
  });
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
    snapshot: () => world.snapshot(),
  });
}

display.resize();
loop.start();
