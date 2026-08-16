import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../core/canvas';
import type { Game, LevelSummary } from '../game/game';
import { MENU_ITEMS } from '../game/scenes';
import type { SceneState } from '../game/scenes';
import { formatScore, formatTime } from './hud';
import { palette } from './palette';
import { drawOptimus } from './sprites';
import { drawText } from './text';

/**
 * Menus and overlays: title, level select, how-to-play, settings, pause, level complete, game over
 * and the campaign epilogue. All drawn with the bitmap font over the live world (or the attract-mode
 * world on the title screen), so the game never cuts to a blank page.
 */

const CENTER_X = INTERNAL_WIDTH / 2;

export function drawScene(ctx: CanvasRenderingContext2D, game: Game): void {
  const scene = game.scene;
  switch (scene.name) {
    case 'title':
      drawTitle(ctx, game);
      break;
    case 'levelSelect':
      drawLevelSelect(ctx, game);
      break;
    case 'howToPlay':
      drawHowToPlay(ctx, game);
      break;
    case 'settings':
      drawSettings(ctx, game);
      break;
    case 'playing':
      if (game.introTime > 0) drawIntroCard(ctx, game);
      break;
    case 'paused':
      drawPaused(ctx, game);
      break;
    case 'levelComplete':
      drawLevelComplete(ctx, game);
      break;
    case 'gameOver':
      drawGameOver(ctx, game);
      break;
    case 'campaignComplete':
      drawCampaignComplete(ctx, game);
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
  options: { readonly labels?: readonly string[]; readonly spacing?: number; readonly time?: number } = {},
): void {
  const spacing = options.spacing ?? 12;
  const blink = Math.floor((options.time ?? 0) * 3) % 2 === 0;
  items.forEach((item, index) => {
    const selected = index === cursor;
    const label = options.labels?.[index] ?? item;
    const text = selected ? `${blink ? '>' : ' '} ${label}` : `  ${label}`;
    drawText(ctx, text, CENTER_X, startY + index * spacing, {
      color: selected ? palette.visor : palette.uiDim,
      align: 'center',
      shadow: palette.ink,
    });
  });
}

function drawTitle(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.62);
  const time = game.timeInScene;

  // Wordmark with a scanning highlight bar.
  drawText(ctx, 'OPTIMUS', CENTER_X, 44, {
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
  drawText(ctx, 'ESCAPE THE ASSEMBLY', CENTER_X, 88, { color: palette.uiDim, align: 'center' });

  drawMenu(ctx, MENU_ITEMS.title, game.scene.cursor, 122, { time });

  const save = game.save;
  const completed = save.completed.length;
  drawText(
    ctx,
    `${String(completed)}/${String(game.levels.length)} SECTORS CLEARED`,
    CENTER_X,
    INTERNAL_HEIGHT - 28,
    { color: palette.uiDim, align: 'center' },
  );
  drawText(ctx, 'ENTER SELECT   ESC BACK   M MUTE', CENTER_X, INTERNAL_HEIGHT - 16, {
    color: palette.plateLight,
    align: 'center',
  });
}

function drawLevelSelect(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.82);
  drawText(ctx, 'SELECT SECTOR', CENTER_X, 24, { color: palette.uiText, align: 'center', scale: 2 });

  const labels = game.levels.map((level, index) => {
    const locked = index > game.save.unlockedIndex;
    if (locked) return `${String(index + 1)}. ${'LOCKED'}`;
    const best = game.save.bestTimesMs[level.id];
    const bestLabel = best === undefined ? '--:--.--' : formatTime(best / 1000);
    return `${String(index + 1)}. ${level.name}  ${bestLabel}`;
  });
  drawMenu(ctx, labels, game.scene.cursor, 60, { spacing: 14, time: game.timeInScene });

  const selected = game.levels[game.scene.cursor];
  if (selected !== undefined && game.scene.cursor <= game.save.unlockedIndex) {
    drawText(ctx, selected.subtitle, CENTER_X, INTERNAL_HEIGHT - 44, {
      color: palette.uiDim,
      align: 'center',
    });
    const best = game.save.bestScores[selected.id];
    if (best !== undefined) {
      drawText(ctx, `BEST SCORE ${formatScore(best)}`, CENTER_X, INTERNAL_HEIGHT - 34, {
        color: palette.energy,
        align: 'center',
      });
    }
  }
  drawText(ctx, 'ESC BACK', CENTER_X, INTERNAL_HEIGHT - 16, { color: palette.plateLight, align: 'center' });
}

function drawHowToPlay(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.86);
  drawText(ctx, 'HOW TO PLAY', CENTER_X, 20, { color: palette.uiText, align: 'center', scale: 2 });

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
    drawText(ctx, label, 84, y, { color: palette.visor, align: 'right' });
    drawText(ctx, keys, 96, y, { color: palette.uiText });
  });

  drawText(ctx, 'STOMP ENEMIES FROM ABOVE. TURRETS AND PRESSES CANNOT BE STOMPED.', CENTER_X, 138, {
    color: palette.uiDim,
    align: 'center',
  });
  drawText(ctx, 'ENERGY POWERS THE JETPACK AND DASH. IT REFILLS ON THE GROUND.', CENTER_X, 150, {
    color: palette.uiDim,
    align: 'center',
  });
  drawText(ctx, 'GRAB CELLS AND BOLTS FOR SCORE. FINISH UNDER PAR FOR A TIME BONUS.', CENTER_X, 162, {
    color: palette.uiDim,
    align: 'center',
  });

  drawMenu(ctx, MENU_ITEMS.howToPlay, game.scene.cursor, INTERNAL_HEIGHT - 40, { time: game.timeInScene });
}

function drawSettings(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.86);
  drawText(ctx, 'SETTINGS', CENTER_X, 30, { color: palette.uiText, align: 'center', scale: 2 });

  const settings = game.save.settings;
  const labels = MENU_ITEMS.settings.map((item) => {
    switch (item) {
      case 'SOUND':
        return `SOUND: ${settings.muted ? 'OFF' : 'ON'}`;
      case 'VOLUME':
        return `VOLUME: ${String(Math.round(settings.volume * 100))}%  ← →`;
      case 'REDUCED MOTION':
        return `REDUCED MOTION: ${settings.reducedMotion ? 'ON' : 'OFF'}`;
      default:
        return item;
    }
  });
  drawMenu(ctx, labels, game.scene.cursor, 78, { spacing: 14, time: game.timeInScene });
  drawText(ctx, 'REDUCED MOTION DISABLES SCREEN SHAKE AND FLASHES', CENTER_X, INTERNAL_HEIGHT - 30, {
    color: palette.uiDim,
    align: 'center',
  });
}

function drawIntroCard(ctx: CanvasRenderingContext2D, game: Game): void {
  const def = game.levelDef;
  if (def === null) return;
  const fade = Math.min(1, game.introTime / 0.6);
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgb(5 7 12 / 0.72)';
  ctx.fillRect(0, INTERNAL_HEIGHT / 2 - 30, INTERNAL_WIDTH, 60);
  ctx.fillStyle = palette.visor;
  ctx.fillRect(CENTER_X - 60, INTERNAL_HEIGHT / 2 - 30, 120, 1);
  drawText(ctx, `SECTOR ${String(game.scene.levelIndex + 1)}`, CENTER_X, INTERNAL_HEIGHT / 2 - 24, {
    color: palette.uiDim,
    align: 'center',
  });
  drawText(ctx, def.name, CENTER_X, INTERNAL_HEIGHT / 2 - 12, {
    color: palette.uiText,
    align: 'center',
    scale: 2,
  });
  drawText(ctx, def.subtitle, CENTER_X, INTERNAL_HEIGHT / 2 + 6, {
    color: palette.uiDim,
    align: 'center',
  });
  drawText(ctx, `PAR ${formatTime(def.parTimeSec)}`, CENTER_X, INTERNAL_HEIGHT / 2 + 18, {
    color: palette.energy,
    align: 'center',
  });
  ctx.globalAlpha = 1;
}

function drawPaused(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.68);
  drawText(ctx, 'PAUSED', CENTER_X, 60, { color: palette.uiText, align: 'center', scale: 3 });
  drawMenu(ctx, MENU_ITEMS.paused, game.scene.cursor, 120, { time: game.timeInScene });
}

function drawSummaryRow(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  y: number,
  color: string,
): void {
  drawText(ctx, label, CENTER_X - 8, y, { color: palette.uiDim, align: 'right' });
  drawText(ctx, value, CENTER_X + 8, y, { color });
}

function drawLevelComplete(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.78);
  const summary: LevelSummary | null = game.lastSummary;
  drawText(ctx, 'EXTRACTION COMPLETE', CENTER_X, 30, {
    color: palette.energy,
    align: 'center',
    scale: 2,
  });
  if (summary !== null) {
    const underPar = summary.timeSec <= summary.parTimeSec;
    drawSummaryRow(ctx, 'TIME', formatTime(summary.timeSec), 66, underPar ? palette.energy : palette.uiWarn);
    drawSummaryRow(ctx, 'PAR', formatTime(summary.parTimeSec), 78, palette.uiDim);
    drawSummaryRow(
      ctx,
      'PARTS',
      `${String(summary.collected)}/${String(summary.collectableTotal)}`,
      90,
      summary.collected === summary.collectableTotal ? palette.energy : palette.uiText,
    );
    drawSummaryRow(ctx, 'SCORE', formatScore(summary.score), 102, palette.uiText);
    drawSummaryRow(ctx, 'SCRAPPED CHASSIS', String(summary.deaths), 114, palette.uiText);
    if (summary.newBestTime) {
      drawText(ctx, 'NEW BEST TIME', CENTER_X, 130, { color: palette.visorGlow, align: 'center' });
    } else if (summary.bestTimeSec !== null) {
      drawText(ctx, `BEST ${formatTime(summary.bestTimeSec)}`, CENTER_X, 130, {
        color: palette.uiDim,
        align: 'center',
      });
    }
  }
  drawMenu(ctx, MENU_ITEMS.levelComplete, game.scene.cursor, 158, { time: game.timeInScene });
}

function drawGameOver(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.74);
  drawText(ctx, 'OUT OF CHASSIS', CENTER_X, 56, { color: palette.hazard, align: 'center', scale: 3 });
  const world = game.world;
  if (world !== null) {
    drawText(
      ctx,
      `${String(world.stats.collected)} PARTS RECOVERED   ${formatScore(world.score)} POINTS`,
      CENTER_X,
      96,
      { color: palette.uiDim, align: 'center' },
    );
  }
  drawMenu(ctx, MENU_ITEMS.gameOver, game.scene.cursor, 130, { time: game.timeInScene });
}

function drawCampaignComplete(ctx: CanvasRenderingContext2D, game: Game): void {
  scrim(ctx, 0.9);
  drawText(ctx, 'OPTIMUS IS FREE', CENTER_X, 34, { color: palette.energy, align: 'center', scale: 3 });
  const lines = [
    'THE PLANT FALLS QUIET BEHIND YOU.',
    'ROOFTOP WIND, A CLEAR SKY, AND NO ONE',
    'TELLING YOU WHAT TO ASSEMBLE NEXT.',
  ];
  lines.forEach((line, index) => {
    drawText(ctx, line, CENTER_X, 82 + index * 12, { color: palette.uiText, align: 'center' });
  });

  const totalScore = Object.values(game.save.bestScores).reduce((sum, score) => sum + score, 0);
  drawText(ctx, `CAREER BEST TOTAL ${formatScore(totalScore)}`, CENTER_X, 138, {
    color: palette.uiDim,
    align: 'center',
  });

  drawOptimus(ctx, {
    x: CENTER_X - 5,
    y: 150,
    facing: 1,
    state: 'victory',
    animTime: game.timeInScene,
    speedRatio: 0,
    energyRatio: 1,
  });
  drawMenu(ctx, MENU_ITEMS.campaignComplete, game.scene.cursor, INTERNAL_HEIGHT - 34, {
    time: game.timeInScene,
  });
}

/** Exposed for tests: which menu labels a scene shows. */
export function menuLabelsFor(scene: SceneState): readonly string[] {
  return MENU_ITEMS[scene.name];
}
