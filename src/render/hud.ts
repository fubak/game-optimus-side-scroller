import { clamp } from '../core/math';
import { ENERGY_LOW_THRESHOLD, HEALTH_MAX } from '../game/constants';
import { OVERSEER_HIT_POINTS } from '../game/enemies';
import type { World } from '../game/world';
import { palette } from './palette';
import { drawText } from './text';

/**
 * Heads-up display: health, energy, dash charge, score, timer and transient toasts.
 *
 * Everything is drawn with the bitmap font and flat rectangles at the internal resolution, so the
 * HUD is pixel-crisp at every window size.
 */

export interface Toast {
  readonly text: string;
  readonly color: string;
  /** Remaining lifetime in seconds. */
  life: number;
  readonly maxLife: number;
}

export class Hud {
  private readonly toasts: Toast[] = [];

  push(text: string, color: string = palette.uiText, life = 1.6): void {
    this.toasts.unshift({ text, color, life, maxLife: life });
    if (this.toasts.length > 4) this.toasts.pop();
  }

  update(dtSec: number): void {
    for (const toast of this.toasts) toast.life -= dtSec;
    while (this.toasts.length > 0 && (this.toasts[this.toasts.length - 1]?.life ?? 0) <= 0) {
      this.toasts.pop();
    }
  }

  clear(): void {
    this.toasts.length = 0;
  }

  draw(ctx: CanvasRenderingContext2D, world: World, viewWidth: number): void {
    const { player } = world;

    // ── Health pips ────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < HEALTH_MAX; i += 1) {
      const x = 6 + i * 9;
      const filled = i < player.health;
      ctx.fillStyle = filled ? palette.health : palette.plateDark;
      ctx.fillRect(x, 6, 7, 6);
      ctx.fillStyle = filled ? palette.white : palette.plateShadow;
      ctx.fillRect(x + 1, 7, 2, 1);
    }

    // ── Energy bar with a low-charge pulse ─────────────────────────────────────────────────────
    const barWidth = 58;
    ctx.fillStyle = palette.plateShadow;
    ctx.fillRect(5, 15, barWidth + 2, 6);
    ctx.fillStyle = palette.energyDim;
    ctx.fillRect(6, 16, barWidth, 4);
    const low = player.energy <= ENERGY_LOW_THRESHOLD;
    const pulse = low ? 0.55 + 0.45 * Math.sin(world.elapsedSec * 12) : 1;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = low ? palette.uiWarn : palette.energy;
    ctx.fillRect(6, 16, Math.round(barWidth * clamp(player.energyRatio, 0, 1)), 4);
    ctx.globalAlpha = 1;

    // ── Dash charge ticks ─────────────────────────────────────────────────────────────────────
    const dashReady = player.dashCharge >= 1;
    ctx.fillStyle = dashReady ? palette.visor : palette.plateDark;
    ctx.fillRect(6, 23, Math.round(20 * player.dashCharge), 2);
    drawText(ctx, 'DASH', 30, 22, { color: dashReady ? palette.visor : palette.uiDim, tracking: 0 });

    // ── Lives ─────────────────────────────────────────────────────────────────────────────────
    drawText(ctx, `×${String(world.livesLeft)}`, 6 + HEALTH_MAX * 9 + 4, 6, { color: palette.uiText });

    // ── Score, collectables and timer ─────────────────────────────────────────────────────────
    const stats = world.stats;
    drawText(ctx, formatScore(stats.score), viewWidth - 6, 6, { color: palette.uiText, align: 'right' });
    drawText(ctx, `${String(stats.collected)}/${String(stats.collectableTotal)} PARTS`, viewWidth - 6, 15, {
      color: palette.uiDim,
      align: 'right',
    });
    const overPar = stats.timeSec > stats.parTimeSec;
    drawText(ctx, formatTime(stats.timeSec), viewWidth - 6, 24, {
      color: overPar ? palette.uiWarn : palette.uiDim,
      align: 'right',
    });

    // ── Boss health ───────────────────────────────────────────────────────────────────────────
    const boss = world.boss;
    if (boss !== null && boss.state !== 'dead') {
      const barWidth = 120;
      const x = Math.round(viewWidth / 2 - barWidth / 2);
      drawText(ctx, 'OVERSEER', viewWidth / 2, 6, { color: palette.hazard, align: 'center' });
      ctx.fillStyle = palette.plateShadow;
      ctx.fillRect(x - 1, 15, barWidth + 2, 6);
      ctx.fillStyle = palette.hazardDark;
      ctx.fillRect(x, 16, barWidth, 4);
      ctx.fillStyle = world.isBossVulnerable(boss) ? palette.visorGlow : palette.hazard;
      ctx.fillRect(x, 16, Math.round((barWidth * Math.max(0, boss.hitPoints)) / OVERSEER_HIT_POINTS), 4);
      if (world.isBossVulnerable(boss)) {
        drawText(ctx, 'CORE EXPOSED — STOMP IT', viewWidth / 2, 24, {
          color: palette.visorGlow,
          align: 'center',
        });
      }
    }

    // ── Toasts ────────────────────────────────────────────────────────────────────────────────
    this.toasts.forEach((toast, index) => {
      const fade = clamp(toast.life / Math.min(0.4, toast.maxLife), 0, 1);
      ctx.globalAlpha = fade;
      drawText(ctx, toast.text, 6, 34 + index * 9, { color: toast.color });
      ctx.globalAlpha = 1;
    });
  }
}

export function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const wholeSeconds = Math.floor(clamped % 60);
  const hundredths = Math.floor((clamped * 100) % 100);
  return `${String(minutes)}:${pad(wholeSeconds)}.${pad(hundredths)}`;
}

export function formatScore(score: number): string {
  return String(Math.max(0, Math.round(score))).padStart(6, '0');
}

function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}
