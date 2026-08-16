import { createDisplay, INTERNAL_HEIGHT, INTERNAL_WIDTH } from './core/canvas';
import { KeyboardInput } from './core/input';
import { createLoop } from './core/loop';
import type { Loop } from './core/loop';
import { createRng } from './core/rng';
import { installTestHooks, shouldInstallTestHooks } from './core/testHooks';
import { Camera } from './game/camera';
import {
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  RUN_MAX_SPEED,
  SHAKE_LANDING,
  LANDING_SHAKE_SPEED,
} from './game/constants';
import { parseTileRows } from './game/levelParser';
import { DEV_PLAYGROUND } from './game/levels/dev';
import { Player } from './game/player';
import type { PlayerEvent } from './game/player';
import { TILE_SIZE, TileKind, tileFlags } from './game/tiles';
import { palette } from './render/palette';
import { ParticleSystem } from './render/particles';
import { drawDashGhost, drawOptimus } from './render/sprites';

/**
 * Movement sandbox bootstrap.
 *
 * Wires the engine pieces together so Optimus can be driven around the playground level. The scene
 * system, HUD and real level flow replace this in later phases; the sandbox keeps the physics and
 * sprite work honest in the browser while they are being built.
 */

const host = document.getElementById('app');
if (host === null) {
  throw new Error('Missing #app host element.');
}

const display = createDisplay(host);
const input = new KeyboardInput(window);
const rng = createRng(1337);
const particles = new ParticleSystem(400);

const { map, markers } = parseTileRows(DEV_PLAYGROUND);
const spawn = markers.find((marker) => marker.glyph === 'P') ?? { tx: 2, ty: 10 };
const spawnX = spawn.tx * TILE_SIZE + (TILE_SIZE - PLAYER_WIDTH) / 2;
const spawnY = (spawn.ty + 1) * TILE_SIZE - PLAYER_HEIGHT;

const player = new Player(spawnX, spawnY);
const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
camera.snapTo(player.body, map);

const events: PlayerEvent[] = [];
let debugVisible = false;
let dashGhosts: { x: number; y: number; facing: 1 | -1; animTime: number; age: number }[] = [];

const loop: Loop = createLoop({
  update(dtSec) {
    events.length = 0;
    player.update(dtSec, input, map, events);
    handlePlayerEvents(dtSec);
    if (player.body.y > map.pixelHeight + 64) {
      player.respawn(spawnX, spawnY);
      camera.snapTo(player.body, map);
    }
    particles.update(dtSec);
    camera.update(dtSec, player.body, player.body.vx, map, rng);
    if (input.justPressed('debug')) debugVisible = !debugVisible;
    if (input.justPressed('restart')) {
      player.respawn(spawnX, spawnY);
      camera.snapTo(player.body, map);
    }
    input.endFrame();
  },
  render() {
    draw();
  },
});

function handlePlayerEvents(dtSec: number): void {
  for (const event of events) {
    switch (event.type) {
      case 'jump':
        particles.landingDust(player.centerX, player.body.y + PLAYER_HEIGHT, 0.5, rng);
        break;
      case 'land': {
        const strength = Math.min(1, Math.abs(event.impactSpeed) / LANDING_SHAKE_SPEED);
        particles.landingDust(player.centerX, player.body.y + PLAYER_HEIGHT, strength, rng);
        if (strength > 0.8) camera.addShake(SHAKE_LANDING);
        break;
      }
      case 'dash':
        particles.burst('spark', player.centerX, player.centerY, 10, rng, { speed: 120 });
        break;
      case 'footstep':
        particles.spawn({
          kind: 'dust',
          x: player.centerX - player.facing * 3,
          y: player.body.y + PLAYER_HEIGHT,
          vx: -player.facing * 12,
          vy: -6,
          life: 0.25,
        });
        break;
      case 'thrustStart':
      case 'thrustStop':
      case 'hurt':
      case 'die':
      case 'energyEmpty':
      case 'ceilingBonk':
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled player event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Jetpack exhaust and dash after-images.
  if (player.state === 'thrust') {
    particles.spawn({
      kind: 'exhaust',
      x: player.centerX + rng.signedRange(2),
      y: player.body.y + PLAYER_HEIGHT,
      vx: rng.signedRange(20),
      vy: rng.range(30, 90),
      life: rng.range(0.15, 0.3),
      size: 2,
    });
  }
  if (player.state === 'dash') {
    dashGhosts.push({
      x: player.body.x,
      y: player.body.y,
      facing: player.facing,
      animTime: player.animTime,
      age: 0,
    });
  }
  dashGhosts = dashGhosts
    .map((ghost) => ({ ...ghost, age: ghost.age + dtSec }))
    .filter((ghost) => ghost.age < 0.18);
}

function draw(): void {
  const { ctx } = display;
  const cameraX = camera.renderX;
  const cameraY = camera.renderY;

  drawBackground(ctx, cameraX, cameraY);
  drawTiles(ctx, cameraX, cameraY);

  for (const ghost of dashGhosts) {
    drawDashGhost(
      ctx,
      {
        x: ghost.x - cameraX,
        y: ghost.y - cameraY,
        facing: ghost.facing,
        state: 'dash',
        animTime: ghost.animTime,
        speedRatio: 1,
        energyRatio: player.energyRatio,
      },
      0.35 * (1 - ghost.age / 0.18),
    );
  }

  const blink = player.isInvulnerable && Math.floor(player.animTime * 12) % 2 === 0;
  if (!blink) {
    drawOptimus(ctx, {
      x: player.body.x - cameraX,
      y: player.body.y - cameraY,
      facing: player.facing,
      state: player.state,
      animTime: player.animTime,
      speedRatio: Math.abs(player.body.vx) / RUN_MAX_SPEED,
      energyRatio: player.energyRatio,
    });
  }

  particles.draw(ctx, cameraX, cameraY);
  drawSandboxHud(ctx);
  if (debugVisible) drawDebugOverlay(ctx);
}

function drawBackground(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, INTERNAL_HEIGHT);
  gradient.addColorStop(0, palette.skyTop);
  gradient.addColorStop(1, palette.skyBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  // Cheap parallax stand-in: vertical girders drifting at half camera speed.
  ctx.fillStyle = palette.farStructure;
  const spacing = 64;
  const offset = Math.round(cameraX * 0.4) % spacing;
  for (let x = -offset; x < INTERNAL_WIDTH; x += spacing) {
    ctx.fillRect(x, 40 - Math.round(cameraY * 0.2), 10, INTERNAL_HEIGHT);
  }
}

function drawTiles(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
  const minTx = Math.max(0, Math.floor(cameraX / TILE_SIZE));
  const maxTx = Math.min(map.width - 1, Math.ceil((cameraX + INTERNAL_WIDTH) / TILE_SIZE));
  const minTy = Math.max(0, Math.floor(cameraY / TILE_SIZE));
  const maxTy = Math.min(map.height - 1, Math.ceil((cameraY + INTERNAL_HEIGHT) / TILE_SIZE));

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const kind = map.tileAt(tx, ty);
      if (kind === TileKind.Empty) continue;
      const x = tx * TILE_SIZE - cameraX;
      const y = ty * TILE_SIZE - cameraY;
      const flags = tileFlags(kind);
      if (flags.hazard) {
        ctx.fillStyle = palette.hazardDark;
        ctx.fillRect(x, y + 8, TILE_SIZE, 8);
        ctx.fillStyle = palette.hazard;
        for (let i = 0; i < 4; i += 1) {
          ctx.fillRect(x + i * 4 + 1, y + 6, 2, 4);
        }
        continue;
      }
      if (flags.oneWay) {
        ctx.fillStyle = palette.plateLight;
        ctx.fillRect(x, y, TILE_SIZE, 3);
        ctx.fillStyle = palette.plateDark;
        ctx.fillRect(x, y + 3, TILE_SIZE, 1);
        continue;
      }
      if (flags.conveyor !== 0) {
        ctx.fillStyle = palette.plateDark;
        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        ctx.fillStyle = palette.rust;
        const shift = Math.floor((performance.now() / 40) * Math.sign(flags.conveyor)) % 8;
        for (let i = -8; i < TILE_SIZE + 8; i += 8) {
          ctx.fillRect(x + ((i + shift + 16) % 16), y + 2, 4, 2);
        }
        continue;
      }
      if (flags.trigger) {
        ctx.fillStyle = kind === TileKind.Goal ? palette.energy : palette.visor;
        ctx.fillRect(x + 4, y + 2, 8, 12);
        continue;
      }
      ctx.fillStyle = palette.plateFace;
      ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
      ctx.fillStyle = palette.plateLight;
      ctx.fillRect(x, y, TILE_SIZE, 1);
      ctx.fillStyle = palette.plateShadow;
      ctx.fillRect(x, y + TILE_SIZE - 1, TILE_SIZE, 1);
    }
  }
}

function drawSandboxHud(ctx: CanvasRenderingContext2D): void {
  ctx.font = '8px ui-monospace, monospace';
  ctx.fillStyle = palette.uiDim;
  ctx.fillText(
    'MOVE ←→   JUMP SPACE (hold in air = jetpack)   DASH SHIFT   R reset   F3 debug',
    6,
    INTERNAL_HEIGHT - 8,
  );

  // Health pips and energy bar.
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = i < player.health ? palette.health : palette.plateDark;
    ctx.fillRect(6 + i * 8, 8, 6, 6);
  }
  ctx.fillStyle = palette.energyDim;
  ctx.fillRect(6, 18, 60, 4);
  ctx.fillStyle = palette.energy;
  ctx.fillRect(6, 18, Math.round(60 * player.energyRatio), 4);
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D): void {
  const { fps, frameTimeMs, updateMs, renderMs } = loop.metrics;
  const lines = [
    `fps ${fps.toFixed(1)} frame ${frameTimeMs.toFixed(2)}ms`,
    `upd ${updateMs.toFixed(2)}ms ren ${renderMs.toFixed(2)}ms`,
    `state ${player.state} grounded ${String(player.isOnGround)}`,
    `pos ${player.body.x.toFixed(1)},${player.body.y.toFixed(1)}`,
    `vel ${player.body.vx.toFixed(1)},${player.body.vy.toFixed(1)}`,
    `energy ${player.energy.toFixed(0)} dash ${(player.dashCharge * 100).toFixed(0)}%`,
    `particles ${String(particles.activeCount)}`,
  ];
  ctx.font = '8px ui-monospace, monospace';
  ctx.fillStyle = 'rgb(0 0 0 / 0.65)';
  ctx.fillRect(INTERNAL_WIDTH - 160, 4, 156, lines.length * 9 + 4);
  ctx.fillStyle = palette.energy;
  lines.forEach((line, index) => {
    ctx.fillText(line, INTERNAL_WIDTH - 156, 13 + index * 9);
  });

  // Collision box.
  ctx.strokeStyle = palette.hazard;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(player.body.x - camera.renderX) + 0.5,
    Math.round(player.body.y - camera.renderY) + 0.5,
    PLAYER_WIDTH - 1,
    PLAYER_HEIGHT - 1,
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
    snapshot: () => ({
      frame: loop.frame,
      player: {
        x: player.body.x,
        y: player.body.y,
        state: player.state,
        health: player.health,
        energy: player.energy,
      },
    }),
  });
}

display.resize();
loop.start();
