import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../core/canvas';
import { PLAYER_HEIGHT, PLAYER_WIDTH, RUN_MAX_SPEED, INVULNERABLE_BLINK_HZ } from '../game/constants';
import type { Pickup } from '../game/pickups';
import type { World } from '../game/world';
import { palette } from './palette';
import { createParallaxLayers, drawParallax } from './parallax';
import type { ParallaxLayer } from './parallax';
import { drawOptimus, drawDashGhost } from './sprites';
import { drawTiles } from './tiles';

/**
 * Draws a {@link World}.
 *
 * Strictly read-only: the renderer never mutates simulation state, which is why the same world can
 * be stepped headlessly in tests and rendered here without behaving differently.
 *
 * Layer order: sky → parallax → tiles → pickups → dash ghosts → Optimus → particles → vignette.
 */

interface DashGhost {
  x: number;
  y: number;
  facing: 1 | -1;
  animTime: number;
  age: number;
}

export class WorldRenderer {
  private layers: ParallaxLayer[];
  private levelId: string;
  private ghosts: DashGhost[] = [];

  constructor(world: World) {
    this.levelId = world.level.id;
    this.layers = createParallaxLayers({
      seed: world.level.seed,
      viewWidth: INTERNAL_WIDTH,
      viewHeight: INTERNAL_HEIGHT,
    });
  }

  /** Rebuild cached art when the level changes. */
  private ensureLevel(world: World): void {
    if (world.level.id === this.levelId) return;
    this.levelId = world.level.id;
    this.ghosts = [];
    this.layers = createParallaxLayers({
      seed: world.level.seed,
      viewWidth: INTERNAL_WIDTH,
      viewHeight: INTERNAL_HEIGHT,
    });
  }

  /** Sample the player's trail; called once per simulation step by the game facade. */
  trackTrail(world: World, dtSec: number): void {
    const { player } = world;
    if (player.state === 'dash') {
      this.ghosts.push({
        x: player.body.x,
        y: player.body.y,
        facing: player.facing,
        animTime: player.animTime,
        age: 0,
      });
    }
    for (const ghost of this.ghosts) ghost.age += dtSec;
    this.ghosts = this.ghosts.filter((ghost) => ghost.age < 0.18);
  }

  draw(ctx: CanvasRenderingContext2D, world: World): void {
    this.ensureLevel(world);
    const cameraX = world.camera.renderX;
    const cameraY = world.camera.renderY;

    drawSky(ctx);
    drawParallax(ctx, this.layers, cameraX, cameraY);
    // Atmospheric scrim: pushes the backdrop behind the playfield so terrain and Optimus pop.
    ctx.fillStyle = 'rgb(9 12 20 / 0.45)';
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    drawTiles(
      {
        ctx,
        map: world.map,
        cameraX,
        cameraY,
        timeSec: world.elapsedSec,
        checkpointActive: (tx, ty) => world.isCheckpointActive(tx, ty),
      },
      INTERNAL_WIDTH,
      INTERNAL_HEIGHT,
    );

    for (const pickup of world.pickups) {
      if (pickup.collected) continue;
      drawPickup(ctx, pickup, world.pickupOffset(pickup), cameraX, cameraY);
    }

    for (const ghost of this.ghosts) {
      drawDashGhost(
        ctx,
        {
          x: ghost.x - cameraX,
          y: ghost.y - cameraY,
          facing: ghost.facing,
          state: 'dash',
          animTime: ghost.animTime,
          speedRatio: 1,
          energyRatio: world.player.energyRatio,
        },
        0.3 * (1 - ghost.age / 0.18),
      );
    }

    const { player } = world;
    const blinkedOut =
      player.isInvulnerable && Math.floor(player.invulnerableTime * INVULNERABLE_BLINK_HZ) % 2 === 1;
    if (!blinkedOut) {
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

    world.particles.draw(ctx, cameraX, cameraY);
    drawVignette(ctx);
  }

  /** Debug overlay: collision boxes and tile grid. */
  drawDebug(ctx: CanvasRenderingContext2D, world: World): void {
    const cameraX = world.camera.renderX;
    const cameraY = world.camera.renderY;
    const tileSize = world.map.tileSize;

    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = palette.visor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -cameraX % tileSize; x < INTERNAL_WIDTH; x += tileSize) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, INTERNAL_HEIGHT);
    }
    for (let y = -cameraY % tileSize; y < INTERNAL_HEIGHT; y += tileSize) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(INTERNAL_WIDTH, y + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = palette.hazard;
    ctx.strokeRect(
      Math.round(world.player.body.x - cameraX) + 0.5,
      Math.round(world.player.body.y - cameraY) + 0.5,
      PLAYER_WIDTH - 1,
      PLAYER_HEIGHT - 1,
    );
  }
}

function drawSky(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, INTERNAL_HEIGHT);
  gradient.addColorStop(0, palette.skyTop);
  gradient.addColorStop(0.7, palette.skyBottom);
  gradient.addColorStop(1, palette.fog);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
}

function drawVignette(ctx: CanvasRenderingContext2D): void {
  // Subtle darkening at the very top and bottom to frame the action.
  const gradient = ctx.createLinearGradient(0, 0, 0, INTERNAL_HEIGHT);
  gradient.addColorStop(0, 'rgb(5 7 12 / 0.35)');
  gradient.addColorStop(0.25, 'rgb(5 7 12 / 0)');
  gradient.addColorStop(0.85, 'rgb(5 7 12 / 0)');
  gradient.addColorStop(1, 'rgb(5 7 12 / 0.4)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
}

function drawPickup(
  ctx: CanvasRenderingContext2D,
  pickup: Pickup,
  bob: number,
  cameraX: number,
  cameraY: number,
): void {
  const x = Math.round(pickup.x - cameraX);
  const y = Math.round(pickup.y - cameraY + bob);
  switch (pickup.kind) {
    case 'energyCell': {
      // Tall canister with a glowing window.
      ctx.fillStyle = palette.plateDark;
      ctx.fillRect(x, y, pickup.width, pickup.height);
      ctx.fillStyle = palette.energy;
      ctx.fillRect(x + 1, y + 2, pickup.width - 2, pickup.height - 4);
      ctx.fillStyle = palette.visorGlow;
      ctx.fillRect(x + 2, y + 3, 2, pickup.height - 6);
      ctx.fillStyle = palette.plateLight;
      ctx.fillRect(x + 1, y, pickup.width - 2, 2);
      ctx.fillRect(x + 1, y + pickup.height - 2, pickup.width - 2, 2);
      break;
    }
    case 'bolt': {
      // Hex nut.
      ctx.fillStyle = palette.plateLight;
      ctx.fillRect(x + 1, y, pickup.width - 2, pickup.height);
      ctx.fillRect(x, y + 1, pickup.width, pickup.height - 2);
      ctx.fillStyle = palette.uiWarn;
      ctx.fillRect(x + 2, y + 2, pickup.width - 4, pickup.height - 4);
      ctx.fillStyle = palette.plateShadow;
      ctx.fillRect(x + 3, y + 3, 1, 1);
      break;
    }
    case 'repairKit': {
      // White case with a cross.
      ctx.fillStyle = palette.shellLight;
      ctx.fillRect(x, y, pickup.width, pickup.height);
      ctx.fillStyle = palette.shellDark;
      ctx.fillRect(x, y + pickup.height - 1, pickup.width, 1);
      ctx.fillStyle = palette.health;
      ctx.fillRect(x + 4, y + 2, 2, 5);
      ctx.fillRect(x + 2, y + 4, 6, 2);
      break;
    }
    default: {
      const exhaustive: never = pickup.kind;
      throw new Error(`Unhandled pickup kind: ${String(exhaustive)}`);
    }
  }
}
