import { createRng } from '../core/rng';
import { palette } from './palette';

/**
 * Procedural parallax backdrop.
 *
 * Three layers of factory silhouettes are generated once into offscreen canvases from the level's
 * seed, then blitted with wrapping offsets. Generating them up front keeps the per-frame cost to a
 * couple of `drawImage` calls, and seeding them means a level's skyline is always the same.
 */

export interface ParallaxLayer {
  readonly canvas: HTMLCanvasElement;
  /** Fraction of camera movement applied to this layer (0 = static, 1 = locked to the world). */
  readonly factor: number;
  /** Vertical placement inside the view, in pixels from the top. */
  readonly offsetY: number;
  readonly verticalFactor: number;
}

export interface ParallaxOptions {
  readonly seed: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
}

function createLayerCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Failed to create a parallax layer context.');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

export function createParallaxLayers(options: ParallaxOptions): ParallaxLayer[] {
  const { seed, viewWidth, viewHeight } = options;
  // Layers are two views wide so a single wrap-around blit covers the screen.
  const width = viewWidth * 2;

  const far = createLayerCanvas(width, Math.round(viewHeight * 0.75));
  paintSkyline(far.ctx, width, far.canvas.height, createRng(seed ^ 0x9e37), {
    color: palette.farStructure,
    accent: palette.fog,
    minHeight: 0.25,
    maxHeight: 0.75,
    towerWidth: [14, 34],
    windowChance: 0.05,
  });

  const mid = createLayerCanvas(width, Math.round(viewHeight * 0.6));
  paintSkyline(mid.ctx, width, mid.canvas.height, createRng(seed ^ 0x2f1b), {
    color: palette.midStructure,
    accent: palette.nearStructure,
    minHeight: 0.3,
    maxHeight: 0.95,
    towerWidth: [10, 26],
    windowChance: 0.09,
  });

  const near = createLayerCanvas(width, Math.round(viewHeight * 0.4));
  paintPipes(near.ctx, width, near.canvas.height, createRng(seed ^ 0x77d1));

  return [
    { canvas: far.canvas, factor: 0.15, offsetY: 8, verticalFactor: 0.05 },
    { canvas: mid.canvas, factor: 0.32, offsetY: Math.round(viewHeight * 0.22), verticalFactor: 0.1 },
    { canvas: near.canvas, factor: 0.55, offsetY: Math.round(viewHeight * 0.55), verticalFactor: 0.18 },
  ];
}

interface SkylineStyle {
  readonly color: string;
  readonly accent: string;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly towerWidth: readonly [number, number];
  readonly windowChance: number;
}

function paintSkyline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rng: ReturnType<typeof createRng>,
  style: SkylineStyle,
): void {
  ctx.clearRect(0, 0, width, height);
  let x = 0;
  while (x < width) {
    const towerWidth = rng.int(style.towerWidth[0], style.towerWidth[1]);
    const towerHeight = Math.round(height * rng.range(style.minHeight, style.maxHeight));
    const top = height - towerHeight;
    ctx.fillStyle = style.color;
    ctx.fillRect(x, top, towerWidth, towerHeight);
    // Roof detail: vents, a chimney or an aerial.
    ctx.fillStyle = style.accent;
    ctx.fillRect(x, top, towerWidth, 1);
    if (rng.chance(0.4)) {
      const chimneyWidth = Math.max(2, Math.round(towerWidth * 0.2));
      const chimneyHeight = rng.int(4, 14);
      ctx.fillStyle = style.color;
      ctx.fillRect(
        x + rng.int(1, Math.max(1, towerWidth - chimneyWidth - 1)),
        top - chimneyHeight,
        chimneyWidth,
        chimneyHeight,
      );
    }
    // Lit windows.
    for (let wy = top + 4; wy < height - 3; wy += 5) {
      for (let wx = x + 2; wx < x + towerWidth - 2; wx += 4) {
        if (!rng.chance(style.windowChance)) continue;
        // Only a few windows are lit warm; the rest are barely brighter than the tower.
        ctx.fillStyle = rng.chance(0.18) ? palette.rust : style.accent;
        ctx.fillRect(wx, wy, 2, 2);
      }
    }
    x += towerWidth + rng.int(0, 6);
  }
}

function paintPipes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rng: ReturnType<typeof createRng>,
): void {
  ctx.clearRect(0, 0, width, height);
  // Horizontal pipe runs with brackets and valves, plus a few vertical drops.
  for (let i = 0; i < 3; i += 1) {
    const y = Math.round(height * rng.range(0.25, 0.85));
    const thickness = rng.int(3, 6);
    ctx.fillStyle = palette.nearStructure;
    ctx.fillRect(0, y, width, thickness);
    ctx.fillStyle = palette.midStructure;
    ctx.fillRect(0, y + thickness - 1, width, 1);
    for (let x = rng.int(0, 40); x < width; x += rng.int(28, 70)) {
      ctx.fillStyle = palette.nearStructure;
      ctx.fillRect(x, y - 2, 3, thickness + 4);
      if (rng.chance(0.35)) {
        ctx.fillStyle = palette.rust;
        ctx.fillRect(x + 1, y - 3, 1, 2);
      }
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const x = rng.int(0, width - 4);
    ctx.fillStyle = palette.midStructure;
    ctx.fillRect(x, 0, rng.int(2, 4), height);
  }
}

/** Blit the layers, wrapping horizontally so the backdrop never runs out. */
export function drawParallax(
  ctx: CanvasRenderingContext2D,
  layers: readonly ParallaxLayer[],
  cameraX: number,
  cameraY: number,
): void {
  for (const layer of layers) {
    const layerWidth = layer.canvas.width;
    const scrolled = (((cameraX * layer.factor) % layerWidth) + layerWidth) % layerWidth;
    const y = Math.round(layer.offsetY - cameraY * layer.verticalFactor);
    ctx.drawImage(layer.canvas, -Math.round(scrolled), y);
    ctx.drawImage(layer.canvas, -Math.round(scrolled) + layerWidth, y);
  }
}
