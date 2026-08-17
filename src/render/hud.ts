import { clamp } from '../core/math';
import { ENERGY_LOW_THRESHOLD, HEALTH_MAX } from '../game/constants';
import { OVERSEER_HIT_POINTS } from '../game/enemies';
import type { World } from '../game/world';
import type { TouchButton } from '../core/touch';
import { fillSoftBar, fillSoftPip } from './hudChrome';
import { palette } from './palette';
import { drawText } from './text';
import type { DrawTextFn } from './text';

/**
 * Heads-up display: health, energy, dash charge, score, timer and transient toasts.
 *
 * Layout is always in 480×270 world-view units. On Enhanced, `main.ts` scales the canvas
 * transform and rasterizes MSDF text at backbuffer resolution (see `uiSpace.ts`) so bars and
 * labels stay sharp; Classic keeps the bitmap font at 1:1. Pass `enhancedChrome: true` for soft
 * layered bars/pips (Enhanced only).
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

  /**
   * @param textDraw Text renderer to use — `drawText` (bitmap, Classic) or `drawTextMsdf`
   *   (distance-field, Enhanced). Defaults to `drawText` so existing callers/tests keep working.
   * @param enhancedChrome Soft layered bars/pips for Enhanced; Classic hard rects when false.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    world: World,
    viewWidth: number,
    textDraw: DrawTextFn = drawText,
    enhancedChrome = false,
  ): void {
    const { player } = world;

    // ── Health pips ────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < HEALTH_MAX; i += 1) {
      const x = 6 + i * 9;
      const filled = i < player.health;
      if (enhancedChrome) {
        fillSoftPip(ctx, x, 6, 7, 6, filled, {
          filled: palette.health,
          empty: palette.plateDark,
          highlight: palette.white,
          emptyShade: palette.plateShadow,
        });
      } else {
        ctx.fillStyle = filled ? palette.health : palette.plateDark;
        ctx.fillRect(x, 6, 7, 6);
        ctx.fillStyle = filled ? palette.white : palette.plateShadow;
        ctx.fillRect(x + 1, 7, 2, 1);
      }
    }

    // ── Energy bar with a low-charge pulse ─────────────────────────────────────────────────────
    const barWidth = 58;
    const low = player.energy <= ENERGY_LOW_THRESHOLD;
    const pulse = low ? 0.55 + 0.45 * Math.sin(world.elapsedSec * 12) : 1;
    if (enhancedChrome) {
      ctx.globalAlpha = pulse;
      fillSoftBar(ctx, 6, 16, barWidth, 4, player.energyRatio, {
        well: palette.plateShadow,
        track: palette.energyDim,
        fill: low ? palette.uiWarn : palette.energy,
        highlight: palette.white,
      });
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = palette.plateShadow;
      ctx.fillRect(5, 15, barWidth + 2, 6);
      ctx.fillStyle = palette.energyDim;
      ctx.fillRect(6, 16, barWidth, 4);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = low ? palette.uiWarn : palette.energy;
      ctx.fillRect(6, 16, Math.round(barWidth * clamp(player.energyRatio, 0, 1)), 4);
      ctx.globalAlpha = 1;
    }

    // ── Dash charge ticks ─────────────────────────────────────────────────────────────────────
    const dashReady = player.dashCharge >= 1;
    if (enhancedChrome) {
      fillSoftBar(ctx, 6, 23, 20, 2, player.dashCharge, {
        well: palette.plateShadow,
        track: palette.plateDark,
        fill: dashReady ? palette.visor : palette.plateFace,
        ...(dashReady ? { highlight: palette.visorGlow } : {}),
      });
    } else {
      ctx.fillStyle = dashReady ? palette.visor : palette.plateDark;
      ctx.fillRect(6, 23, Math.round(20 * player.dashCharge), 2);
    }
    textDraw(ctx, 'DASH', 30, 22, { color: dashReady ? palette.visor : palette.uiDim, tracking: 0 });

    // ── Lives ─────────────────────────────────────────────────────────────────────────────────
    textDraw(ctx, `×${String(world.livesLeft)}`, 6 + HEALTH_MAX * 9 + 4, 6, { color: palette.uiText });

    // ── Score, collectables and timer ─────────────────────────────────────────────────────────
    const stats = world.stats;
    textDraw(ctx, formatScore(stats.score), viewWidth - 6, 6, { color: palette.uiText, align: 'right' });
    textDraw(ctx, `${String(stats.collected)}/${String(stats.collectableTotal)} PARTS`, viewWidth - 6, 15, {
      color: palette.uiDim,
      align: 'right',
    });
    const overPar = stats.timeSec > stats.parTimeSec;
    textDraw(ctx, formatTime(stats.timeSec), viewWidth - 6, 24, {
      color: overPar ? palette.uiWarn : palette.uiDim,
      align: 'right',
    });

    // ── Boss health ───────────────────────────────────────────────────────────────────────────
    const boss = world.isBossEngaged ? world.boss : null;
    if (boss !== null) {
      const bossBarWidth = 120;
      const x = Math.round(viewWidth / 2 - bossBarWidth / 2);
      textDraw(ctx, 'OVERSEER', viewWidth / 2, 6, { color: palette.hazard, align: 'center' });
      if (enhancedChrome) {
        fillSoftBar(ctx, x, 16, bossBarWidth, 4, Math.max(0, boss.hitPoints) / OVERSEER_HIT_POINTS, {
          well: palette.plateShadow,
          track: palette.hazardDark,
          fill: world.isBossVulnerable(boss) ? palette.visorGlow : palette.hazard,
          highlight: palette.white,
        });
      } else {
        ctx.fillStyle = palette.plateShadow;
        ctx.fillRect(x - 1, 15, bossBarWidth + 2, 6);
        ctx.fillStyle = palette.hazardDark;
        ctx.fillRect(x, 16, bossBarWidth, 4);
        ctx.fillStyle = world.isBossVulnerable(boss) ? palette.visorGlow : palette.hazard;
        ctx.fillRect(x, 16, Math.round((bossBarWidth * Math.max(0, boss.hitPoints)) / OVERSEER_HIT_POINTS), 4);
      }
      if (world.isBossVulnerable(boss)) {
        textDraw(ctx, 'CORE EXPOSED — STOMP IT', viewWidth / 2, 24, {
          color: palette.visorGlow,
          align: 'center',
        });
      }
    }

    // ── Toasts ────────────────────────────────────────────────────────────────────────────────
    this.toasts.forEach((toast, index) => {
      const fade = clamp(toast.life / Math.min(0.4, toast.maxLife), 0, 1);
      ctx.globalAlpha = fade;
      textDraw(ctx, toast.text, 6, 34 + index * 9, { color: toast.color });
      ctx.globalAlpha = 1;
    });
  }
}

/** Draw the on-screen touch controls (only called when they are enabled). */
export function drawTouchControls(
  ctx: CanvasRenderingContext2D,
  buttons: readonly TouchButton[],
  active: readonly string[],
  textDraw: DrawTextFn = drawText,
): void {
  for (const button of buttons) {
    // The invisible "tap anywhere to confirm" region has no label and is never drawn.
    if (button.label === '') continue;
    const pressed = active.includes(button.action);
    ctx.globalAlpha = pressed ? 0.75 : 0.4;
    ctx.fillStyle = pressed ? palette.visor : palette.plateFace;
    if (button.round) {
      const cx = button.x + button.width / 2;
      const cy = button.y + button.height / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(button.width, button.height) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(button.x, button.y, button.width, button.height);
    }
    ctx.globalAlpha = pressed ? 1 : 0.8;
    textDraw(ctx, button.label, button.x + button.width / 2, button.y + button.height / 2 - 3, {
      color: pressed ? palette.ink : palette.uiText,
      align: 'center',
    });
    ctx.globalAlpha = 1;
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
