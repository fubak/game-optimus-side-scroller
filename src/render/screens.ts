import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../core/canvas';
import type { Game, LevelSummary } from '../game/game';
import { MENU_ITEMS } from '../game/scenes';
import type { SceneState } from '../game/scenes';
import { drawOptimusVictory } from './drawOptimusEnhanced';
import { formatScore, formatTime } from './hud';
import { palette } from './palette';
import { drawOptimus } from './sprites';
import { drawText } from './text';
import type { DrawTextFn } from './text';

/**
 * Menus and overlays: title, level select, how-to-play, settings, pause, level complete, game over
 * and the campaign epilogue. All drawn with the bitmap font over the live world (or the attract-mode
 * world on the title screen), so the game never cuts to a blank page.
 */

const CENTER_X = INTERNAL_WIDTH / 2;

/**
 * Full-screen transition wipe.
 *
 * Every scene change fades in from black over a fraction of a second, which stops menus from
 * snapping in and hides the one-frame pop when a level's art is built.
 */
export function drawSceneTransition(ctx: CanvasRenderingContext2D, game: Game): void {
  const duration = 0.28;
  if (game.timeInScene >= duration) return;
  const alpha = 1 - game.timeInScene / duration;
  ctx.fillStyle = `rgb(5 7 12 / ${String(alpha * 0.9)})`;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
}

/**
 * Red vignette while Optimus is hurt, and a white flash on the frame damage lands.
 *
 * Suppressed entirely in reduced-motion mode, where the health pips are the only feedback.
 */
export function drawDamageFeedback(ctx: CanvasRenderingContext2D, game: Game): void {
  if (game.save.settings.reducedMotion) return;
  const world = game.world;
  if (world === null) return;
  const invulnerable = world.player.invulnerableTime;
  if (invulnerable <= 0) return;
  const strength = Math.min(1, invulnerable / 1.2);
  const gradient = ctx.createLinearGradient(0, 0, 0, INTERNAL_HEIGHT);
  gradient.addColorStop(0, `rgb(217 86 79 / ${String(strength * 0.35)})`);
  gradient.addColorStop(0.4, 'rgb(217 86 79 / 0)');
  gradient.addColorStop(0.6, 'rgb(217 86 79 / 0)');
  gradient.addColorStop(1, `rgb(217 86 79 / ${String(strength * 0.35)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
}

/**
 * @param textDraw Text renderer to use — `drawText` (bitmap, Classic) or `drawTextMsdf`
 *   (distance-field, Enhanced). Defaults to `drawText` so existing callers/tests keep working.
 * @param enhanced When true, epilogue Optimus uses the Tesla polymer rig instead of Classic bricks.
 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  game: Game,
  textDraw: DrawTextFn = drawText,
  enhanced = false,
): void {
  const scene = game.scene;
  switch (scene.name) {
    case 'title':
      drawTitle(ctx, game, textDraw);
      break;
    case 'levelSelect':
      drawLevelSelect(ctx, game, textDraw);
      break;
    case 'howToPlay':
      drawHowToPlay(ctx, game, textDraw);
      break;
    case 'settings':
      drawSettings(ctx, game, textDraw);
      break;
    case 'playing':
      if (game.introTime > 0) drawIntroCard(ctx, game, textDraw);
      break;
    case 'paused':
      drawPaused(ctx, game, textDraw);
      break;
    case 'levelComplete':
      drawLevelComplete(ctx, game, textDraw);
      break;
    case 'gameOver':
      drawGameOver(ctx, game, textDraw);
      break;
    case 'campaignComplete':
      drawCampaignComplete(ctx, game, textDraw, enhanced);
      break;
    default: {
      const exhaustive: never = scene.name;
      throw new Error(`Unhandled scene in renderer: ${String(exhaustive)}`);
    }
  }
}

function scrim(ctx: CanvasRenderingContext2D, alpha: number): void {
  ctx.fillStyle = `rgb(5 7 12 / ${String(alpha)})`;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
}

function drawMenu(
  ctx: CanvasRenderingContext2D,
  items: readonly string[],
  cursor: number,
  startY: number,
  textDraw: DrawTextFn,
  options: { readonly labels?: readonly string[]; readonly spacing?: number; readonly time?: number } = {},
): void {
  const spacing = options.spacing ?? 12;
  const blink = Math.floor((options.time ?? 0) * 3) % 2 === 0;
  items.forEach((item, index) => {
    const selected = index === cursor;
    const label = options.labels?.[index] ?? item;
    const text = selected ? `${blink ? '>' : ' '} ${label}` : `  ${label}`;
    textDraw(ctx, text, CENTER_X, startY + index * spacing, {
      color: selected ? palette.visor : palette.uiDim,
      align: 'center',
      shadow: palette.ink,
    });
  });
}

function drawTitle(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.62);
  const time = game.timeInScene;

  // Wordmark with a scanning highlight bar.
  textDraw(ctx, 'OPTIMUS', CENTER_X, 44, {
    color: palette.shellLight,
    align: 'center',
    scale: 5,
    shadow: palette.ink,
  });
  const sweep = (Math.sin(time * 1.4) * 0.5 + 0.5) * 150;
  ctx.fillStyle = palette.visor;
  ctx.fillRect(CENTER_X - 75 + sweep * 0, 80, 150, 1);
  ctx.fillStyle = palette.visorGlow;
  ctx.fillRect(CENTER_X - 75 + sweep, 80, 12, 1);
  textDraw(ctx, 'ESCAPE THE ASSEMBLY', CENTER_X, 88, { color: palette.uiDim, align: 'center' });

  drawMenu(ctx, MENU_ITEMS.title, game.scene.cursor, 122, textDraw, { time });

  const save = game.save;
  const completed = save.completed.length;
  textDraw(
    ctx,
    `${String(completed)}/${String(game.levels.length)} SECTORS CLEARED`,
    CENTER_X,
    INTERNAL_HEIGHT - 28,
    { color: palette.uiDim, align: 'center' },
  );
  textDraw(ctx, 'ENTER SELECT   ESC BACK   M MUTE', CENTER_X, INTERNAL_HEIGHT - 16, {
    color: palette.plateLight,
    align: 'center',
  });
}

function drawLevelSelect(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.82);
  textDraw(ctx, 'SELECT SECTOR', CENTER_X, 24, { color: palette.uiText, align: 'center', scale: 2 });

  const labels = game.levels.map((level, index) => {
    const locked = index > game.save.unlockedIndex;
    if (locked) return `${String(index + 1)}. ${'LOCKED'}`;
    const best = game.save.bestTimesMs[level.id];
    const bestLabel = best === undefined ? '--:--.--' : formatTime(best / 1000);
    return `${String(index + 1)}. ${level.name}  ${bestLabel}`;
  });
  drawMenu(ctx, labels, game.scene.cursor, 60, textDraw, { spacing: 14, time: game.timeInScene });

  const selected = game.levels[game.scene.cursor];
  if (selected !== undefined && game.scene.cursor <= game.save.unlockedIndex) {
    textDraw(ctx, selected.subtitle, CENTER_X, INTERNAL_HEIGHT - 44, {
      color: palette.uiDim,
      align: 'center',
    });
    const best = game.save.bestScores[selected.id];
    if (best !== undefined) {
      textDraw(ctx, `BEST SCORE ${formatScore(best)}`, CENTER_X, INTERNAL_HEIGHT - 34, {
        color: palette.energy,
        align: 'center',
      });
    }
  }
  textDraw(ctx, 'ESC BACK', CENTER_X, INTERNAL_HEIGHT - 16, { color: palette.plateLight, align: 'center' });
}

function drawHowToPlay(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.86);
  textDraw(ctx, 'HOW TO PLAY', CENTER_X, 20, { color: palette.uiText, align: 'center', scale: 2 });

  const rows: readonly (readonly [string, string])[] = [
    ['MOVE', '← →  OR  A D'],
    ['JUMP', 'SPACE  (TAP LOW, HOLD HIGH)'],
    ['JETPACK', 'PRESS JUMP AGAIN IN THE AIR AND HOLD'],
    ['DASH', 'SHIFT  OR  J'],
    ['DROP THROUGH', 'HOLD ↓ ON A CATWALK'],
    ['PAUSE', 'ESC   RESTART: R   MUTE: M'],
  ];
  rows.forEach(([label, keys], index) => {
    const y = 46 + index * 13;
    textDraw(ctx, label, 84, y, { color: palette.visor, align: 'right' });
    textDraw(ctx, keys, 96, y, { color: palette.uiText });
  });

  textDraw(ctx, 'STOMP ENEMIES FROM ABOVE. TURRETS AND PRESSES CANNOT BE STOMPED.', CENTER_X, 138, {
    color: palette.uiDim,
    align: 'center',
  });
  textDraw(ctx, 'ENERGY POWERS THE JETPACK AND DASH. IT REFILLS ON THE GROUND.', CENTER_X, 150, {
    color: palette.uiDim,
    align: 'center',
  });
  textDraw(ctx, 'GRAB CELLS AND BOLTS FOR SCORE. FINISH UNDER PAR FOR A TIME BONUS.', CENTER_X, 162, {
    color: palette.uiDim,
    align: 'center',
  });

  drawMenu(ctx, MENU_ITEMS.howToPlay, game.scene.cursor, INTERNAL_HEIGHT - 40, textDraw, { time: game.timeInScene });
}

function drawSettings(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.86);
  textDraw(ctx, 'SETTINGS', CENTER_X, 30, { color: palette.uiText, align: 'center', scale: 2 });

  const settings = game.save.settings;
  const labels = MENU_ITEMS.settings.map((item) => {
    switch (item) {
      case 'SOUND':
        return `SOUND: ${settings.muted ? 'OFF' : 'ON'}`;
      case 'VOLUME':
        return `VOLUME: ${String(Math.round(settings.volume * 100))}%  ← →`;
      case 'REDUCED MOTION':
        return `REDUCED MOTION: ${settings.reducedMotion ? 'ON' : 'OFF'}`;
      case 'HIGH CONTRAST':
        return `HIGH CONTRAST: ${settings.highContrast ? 'ON' : 'OFF'}`;
      case 'KEY LAYOUT':
        return `KEY LAYOUT: ${settings.altBindings ? 'Z / X' : 'SPACE / SHIFT'}`;
      default:
        return item;
    }
  });
  drawMenu(ctx, labels, game.scene.cursor, 62, textDraw, { spacing: 13, time: game.timeInScene });
  textDraw(ctx, 'REDUCED MOTION DISABLES SCREEN SHAKE AND FLASHES', CENTER_X, INTERNAL_HEIGHT - 32, {
    color: palette.uiDim,
    align: 'center',
  });
  textDraw(ctx, 'HIGH CONTRAST BRIGHTENS TERRAIN AND DIMS THE BACKDROP', CENTER_X, INTERNAL_HEIGHT - 22, {
    color: palette.uiDim,
    align: 'center',
  });
}

function drawIntroCard(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  const def = game.levelDef;
  if (def === null) return;
  const fade = Math.min(1, game.introTime / 0.6);
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgb(5 7 12 / 0.72)';
  ctx.fillRect(0, INTERNAL_HEIGHT / 2 - 30, INTERNAL_WIDTH, 60);
  ctx.fillStyle = palette.visor;
  ctx.fillRect(CENTER_X - 60, INTERNAL_HEIGHT / 2 - 30, 120, 1);
  textDraw(ctx, `SECTOR ${String(game.scene.levelIndex + 1)}`, CENTER_X, INTERNAL_HEIGHT / 2 - 24, {
    color: palette.uiDim,
    align: 'center',
  });
  textDraw(ctx, def.name, CENTER_X, INTERNAL_HEIGHT / 2 - 12, {
    color: palette.uiText,
    align: 'center',
    scale: 2,
  });
  textDraw(ctx, def.subtitle, CENTER_X, INTERNAL_HEIGHT / 2 + 6, {
    color: palette.uiDim,
    align: 'center',
  });
  textDraw(ctx, `PAR ${formatTime(def.parTimeSec)}`, CENTER_X, INTERNAL_HEIGHT / 2 + 18, {
    color: palette.energy,
    align: 'center',
  });
  ctx.globalAlpha = 1;
}

function drawPaused(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.68);
  textDraw(ctx, 'PAUSED', CENTER_X, 60, { color: palette.uiText, align: 'center', scale: 3 });
  drawMenu(ctx, MENU_ITEMS.paused, game.scene.cursor, 120, textDraw, { time: game.timeInScene });
}

function drawSummaryRow(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  y: number,
  color: string,
  textDraw: DrawTextFn,
): void {
  textDraw(ctx, label, CENTER_X - 8, y, { color: palette.uiDim, align: 'right' });
  textDraw(ctx, value, CENTER_X + 8, y, { color });
}

function drawLevelComplete(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.78);
  const summary: LevelSummary | null = game.lastSummary;
  textDraw(ctx, 'EXTRACTION COMPLETE', CENTER_X, 30, {
    color: palette.energy,
    align: 'center',
    scale: 2,
  });
  if (summary !== null) {
    const underPar = summary.timeSec <= summary.parTimeSec;
    drawSummaryRow(ctx, 'TIME', formatTime(summary.timeSec), 66, underPar ? palette.energy : palette.uiWarn, textDraw);
    drawSummaryRow(ctx, 'PAR', formatTime(summary.parTimeSec), 78, palette.uiDim, textDraw);
    drawSummaryRow(
      ctx,
      'PARTS',
      `${String(summary.collected)}/${String(summary.collectableTotal)}`,
      90,
      summary.collected === summary.collectableTotal ? palette.energy : palette.uiText,
      textDraw,
    );
    drawSummaryRow(ctx, 'SCORE', formatScore(summary.score), 102, palette.uiText, textDraw);
    drawSummaryRow(ctx, 'SCRAPPED CHASSIS', String(summary.deaths), 114, palette.uiText, textDraw);
    if (summary.newBestTime) {
      textDraw(ctx, 'NEW BEST TIME', CENTER_X, 130, { color: palette.visorGlow, align: 'center' });
    } else if (summary.bestTimeSec !== null) {
      textDraw(ctx, `BEST ${formatTime(summary.bestTimeSec)}`, CENTER_X, 130, {
        color: palette.uiDim,
        align: 'center',
      });
    }
  }
  drawMenu(ctx, MENU_ITEMS.levelComplete, game.scene.cursor, 158, textDraw, { time: game.timeInScene });
}

function drawGameOver(ctx: CanvasRenderingContext2D, game: Game, textDraw: DrawTextFn): void {
  scrim(ctx, 0.74);
  textDraw(ctx, 'OUT OF CHASSIS', CENTER_X, 56, { color: palette.hazard, align: 'center', scale: 3 });
  const world = game.world;
  if (world !== null) {
    textDraw(
      ctx,
      `${String(world.stats.collected)} PARTS RECOVERED   ${formatScore(world.score)} POINTS`,
      CENTER_X,
      96,
      { color: palette.uiDim, align: 'center' },
    );
  }
  drawMenu(ctx, MENU_ITEMS.gameOver, game.scene.cursor, 130, textDraw, { time: game.timeInScene });
}

function drawCampaignComplete(
  ctx: CanvasRenderingContext2D,
  game: Game,
  textDraw: DrawTextFn,
  enhanced: boolean,
): void {
  scrim(ctx, 0.9);
  textDraw(ctx, 'OPTIMUS IS FREE', CENTER_X, 34, { color: palette.energy, align: 'center', scale: 3 });
  const lines = [
    'THE PLANT FALLS QUIET BEHIND YOU.',
    'ROOFTOP WIND, A CLEAR SKY, AND NO ONE',
    'TELLING YOU WHAT TO ASSEMBLE NEXT.',
  ];
  lines.forEach((line, index) => {
    textDraw(ctx, line, CENTER_X, 82 + index * 12, { color: palette.uiText, align: 'center' });
  });

  const totalScore = Object.values(game.save.bestScores).reduce((sum, score) => sum + score, 0);
  textDraw(ctx, `CAREER BEST TOTAL ${formatScore(totalScore)}`, CENTER_X, 138, {
    color: palette.uiDim,
    align: 'center',
  });

  if (enhanced) {
    drawOptimusVictory(ctx, CENTER_X - 5, 150, game.timeInScene);
  } else {
    drawOptimus(ctx, {
      x: CENTER_X - 5,
      y: 150,
      facing: 1,
      state: 'victory',
      animTime: game.timeInScene,
      speedRatio: 0,
      energyRatio: 1,
    });
  }
  drawMenu(ctx, MENU_ITEMS.campaignComplete, game.scene.cursor, INTERNAL_HEIGHT - 34, textDraw, {
    time: game.timeInScene,
  });
}

/** Exposed for tests: which menu labels a scene shows. */
export function menuLabelsFor(scene: SceneState): readonly string[] {
  return MENU_ITEMS[scene.name];
}
