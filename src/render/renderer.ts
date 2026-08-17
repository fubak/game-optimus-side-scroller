import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../core/canvas';
import { PLAYER_HEIGHT, PLAYER_WIDTH, RUN_MAX_SPEED, INVULNERABLE_BLINK_HZ } from '../game/constants';
import { ENEMY_DEATH_TIME, PROJECTILE_SIZE } from '../game/enemies';
import type { Enemy } from '../game/enemies';
import type { Pickup } from '../game/pickups';
import type { World } from '../game/world';
import { palette } from './palette';
import { createParallaxLayers, drawParallax } from './parallax';
import type { ParallaxLayer } from './parallax';
import {
  drawCrusher,
  drawDashGhost,
  drawDrone,
  drawOptimus,
  drawOverseer,
  drawProjectile,
  drawTurret,
  drawWalker,
} from './sprites';
import { drawTiles } from './tiles';
import type { WorldView } from './view';

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

interface Point {
  x: number;
  y: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Classic Canvas2D {@link WorldView}.
 *
 * `WorldRenderer` is kept as the exported name (see the alias below) so existing imports —
 * `import { WorldRenderer } from './render/renderer'` — keep working unchanged.
 */
export class ClassicWorldRenderer implements WorldView {
  readonly backend = 'classic';

  private layers: ParallaxLayer[];
  private levelId: string;
  private ghosts: DashGhost[] = [];

  /**
   * Camera/player positions from the previous simulation step, used to interpolate draw position
   * when `alpha` is supplied. GL will lean on this same pattern harder; Classic only needs it to
   * satisfy the `WorldView` contract without changing its own pixel-snapped look.
   */
  private prevCamera: Point | null = null;
  private currCamera: Point | null = null;
  private prevPlayer: Point | null = null;
  private currPlayer: Point | null = null;

  constructor(world: World | null) {
    this.levelId = world?.level.id ?? '';
    this.layers = createParallaxLayers({
      seed: world?.level.seed ?? 1,
      viewWidth: INTERNAL_WIDTH,
      viewHeight: INTERNAL_HEIGHT,
    });
  }

  /** Rebuild cached art when the level changes. */
  private ensureLevel(world: World): void {
    if (world.level.id === this.levelId) return;
    this.levelId = world.level.id;
    this.ghosts = [];
    this.prevCamera = null;
    this.currCamera = null;
    this.prevPlayer = null;
    this.currPlayer = null;
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

    this.prevCamera = this.currCamera ?? { x: world.camera.renderX, y: world.camera.renderY };
    this.currCamera = { x: world.camera.renderX, y: world.camera.renderY };
    this.prevPlayer = this.currPlayer ?? { x: player.body.x, y: player.body.y };
    this.currPlayer = { x: player.body.x, y: player.body.y };
  }

  /**
   * @param alpha Interpolation factor in [0,1) between the previous and current simulation step.
   *   Omitted or `0` draws at the current step's position exactly as before — Classic only lerps
   *   camera/player draw position when a non-zero alpha is explicitly requested.
   */
  draw(ctx: CanvasRenderingContext2D, world: World, alpha?: number): void {
    this.ensureLevel(world);
    const camera = this.interpolatedCamera(world, alpha);
    const cameraX = camera.x;
    const cameraY = camera.y;

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

    for (const enemy of world.enemies) {
      if (enemy.state === 'dead') continue;
      drawEnemy(
        ctx,
        enemy,
        cameraX,
        cameraY,
        world.isCrusherTelegraphing(enemy),
        world.isBossVulnerable(enemy),
      );
    }

    for (const projectile of world.projectiles.all) {
      if (!projectile.active) continue;
      drawProjectile(
        ctx,
        Math.round(projectile.x - cameraX),
        Math.round(projectile.y - cameraY),
        PROJECTILE_SIZE,
        world.elapsedSec,
      );
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
    const playerPos = this.interpolatedPlayer(world, alpha);
    const blinkedOut =
      player.isInvulnerable && Math.floor(player.invulnerableTime * INVULNERABLE_BLINK_HZ) % 2 === 1;
    if (!blinkedOut) {
      drawOptimus(ctx, {
        x: playerPos.x - cameraX,
        y: playerPos.y - cameraY,
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

  private interpolatedCamera(world: World, alpha: number | undefined): Point {
    if (alpha === undefined || alpha <= 0 || this.prevCamera === null || this.currCamera === null) {
      return { x: world.camera.renderX, y: world.camera.renderY };
    }
    return {
      x: lerp(this.prevCamera.x, this.currCamera.x, alpha),
      y: lerp(this.prevCamera.y, this.currCamera.y, alpha),
    };
  }

  private interpolatedPlayer(world: World, alpha: number | undefined): Point {
    if (alpha === undefined || alpha <= 0 || this.prevPlayer === null || this.currPlayer === null) {
      return { x: world.player.body.x, y: world.player.body.y };
    }
    return {
      x: lerp(this.prevPlayer.x, this.currPlayer.x, alpha),
      y: lerp(this.prevPlayer.y, this.currPlayer.y, alpha),
    };
  }
}

/** Alias kept for source compatibility with existing `import { WorldRenderer } from './render/renderer'`. */
export const WorldRenderer = ClassicWorldRenderer;
export type WorldRenderer = ClassicWorldRenderer;

function drawEnemy(
  ctx: CanvasRenderingContext2D,
  enemy: Enemy,
  cameraX: number,
  cameraY: number,
  telegraphing: boolean,
  vulnerable = false,
): void {
  const options = {
    x: Math.round(enemy.body.x - cameraX),
    y: Math.round(enemy.body.y - cameraY),
    width: enemy.body.width,
    height: enemy.body.height,
    facing: enemy.direction,
    animTime: enemy.animTime,
    dying: enemy.state === 'dying' ? 1 - enemy.deathTimer / ENEMY_DEATH_TIME : 0,
    telegraph: telegraphing || enemy.lethal,
  };
  switch (enemy.kind) {
    case 'walker':
      drawWalker(ctx, options);
      break;
    case 'drone':
      drawDrone(ctx, options);
      break;
    case 'turret':
      drawTurret(ctx, options);
      break;
    case 'crusher':
      drawCrusher(ctx, options);
      break;
    case 'overseer':
      drawOverseer(ctx, { ...options, vulnerable, hitPoints: enemy.hitPoints });
      break;
    default: {
      const exhaustive: never = enemy.kind;
      throw new Error(`Unhandled enemy kind in renderer: ${String(exhaustive)}`);
    }
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
