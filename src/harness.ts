/**
 * The capture harness.
 *
 * Installed only when the page is loaded with `?harness=1`. It replaces the
 * normal real-time loop with one the recorder drives by hand, one frame at a
 * time, on a virtual clock.
 *
 * ## Why this exists
 *
 * The machine this project is developed on has no GPU, so the renderer runs on
 * a software rasteriser at roughly a third of a second per frame. Recording in
 * real time would produce three-frames-per-second footage that says nothing
 * about how the game actually looks in motion.
 *
 * By stamping every frame as exactly 1/60 s regardless of how long it really
 * took to draw, the recorder produces true 60 fps footage from a machine
 * hundreds of times too slow to play the game. The same mechanism makes
 * captures *reproducible*: identical seed plus identical input tape yields
 * identical frames, so a visual difference between two builds is always
 * attributable to a code change rather than to timing luck.
 *
 * Frames are encoded to JPEG *inside the page* and transferred in batches.
 * Playwright's `page.screenshot()` was measured at 3.1 s per frame against
 * 33 ms for in-page `canvas.toBlob` — a 95x difference that decides whether the
 * whole build/critique loop is affordable.
 */

import type { Device } from './gfx/device.ts';
import type { Pipeline } from './render/pipeline.ts';
import type { GameLoop } from './core/loop.ts';
import type { VirtualClock } from './core/time.ts';
import type { Game } from './game/game.ts';
import { input, type Action } from './core/input.ts';
import { reseedAll } from './core/rng.ts';
import { Quality } from './core/config.ts';
import { analyzeFrame, type FrameMetrics } from './metrics/analyze.ts';

export interface HarnessContext {
  game: Game;
  pipeline: Pipeline;
  device: Device;
  loop: GameLoop;
  clock: VirtualClock;
  canvas: HTMLCanvasElement;
}

/** One entry in a scripted input tape. */
export interface TapeEntry {
  /** Seconds from the start of the scenario at which this state begins. */
  time: number;
  moveX?: number;
  moveY?: number;
  /** Actions held from this moment until the next entry changes them. */
  held?: Action[];
}

export interface HarnessApi {
  ready: boolean;
  seed(value: number): void;
  setQuality(quality: number): void;
  setResolution(width: number, height: number): void;
  setDebugView(view: number): void;
  /** Frame the character at a given visible world height, in metres. */
  setCamera(x: number, y: number, viewHeightMetres: number): void;
  /** Freeze the placeholder locomotion at a fixed velocity. */
  setPlayerVelocity(velocity: number | null): void;
  playTape(tape: TapeEntry[]): void;
  clearTape(): void;
  /** Advance exactly one frame of `dtSeconds` and render it. */
  step(dtSeconds?: number): void;
  /** Advance several frames without capturing, e.g. to settle a scene. */
  warmup(frames: number, dtSeconds?: number): void;
  /** Encode the current framebuffer as a JPEG data URL. */
  captureJPEG(quality?: number): Promise<string>;
  /** Encode the current framebuffer as a PNG data URL. */
  capturePNG(): Promise<string>;
  /** Per-frame renderer statistics. */
  stats(): Record<string, number>;
  /** Objective image metrics for the current frame. */
  analyze(): FrameMetrics;
  elapsed(): number;
  frameCount(): number;
}

export function installHarness(context: HarnessContext): void {
  const { game, pipeline, device, loop, clock, canvas } = context;

  let frames = 0;
  let tape: TapeEntry[] | null = null;

  /**
   * Resolves the tape entry active at a given time.
   *
   * Entries are held until superseded, so a tape describes state changes rather
   * than every frame — which keeps scenario files short and readable.
   */
  const tapeAt = (time: number): TapeEntry | null => {
    if (!tape || tape.length === 0) return null;
    let active: TapeEntry | null = null;
    for (const entry of tape) {
      if (entry.time <= time) active = entry;
      else break;
    }
    return active;
  };

  const api: HarnessApi = {
    ready: true,

    seed(value: number): void {
      reseedAll(value);
    },

    setQuality(quality: number): void {
      pipeline.setQuality(quality as Quality);
    },

    setResolution(width: number, height: number): void {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      pipeline.resize(width, height);
      game.resize(width, height);
    },

    setDebugView(view: number): void {
      pipeline.debugView = view;
    },

    setCamera(x: number, y: number, viewHeightMetres: number): void {
      game.setCameraOverride(x, y, viewHeightMetres);
    },

    setPlayerVelocity(velocity: number | null): void {
      game.setVelocityOverride(velocity);
    },

    playTape(entries: TapeEntry[]): void {
      tape = [...entries].sort((a, b) => a.time - b.time);
      input.setTape((time) => {
        const entry = tapeAt(time);
        if (!entry) return {};
        const held = new Array<boolean>(16).fill(false);
        for (const action of entry.held ?? []) held[action] = true;
        return { moveX: entry.moveX ?? 0, moveY: entry.moveY ?? 0, held };
      });
    },

    clearTape(): void {
      tape = null;
      input.setTape(null);
    },

    step(dtSeconds = 1 / 60): void {
      // Advancing the virtual clock and stepping the loop by the same amount
      // keeps every consumer of "now" in agreement.
      clock.advance(dtSeconds);
      loop.step(dtSeconds);
      frames++;
    },

    warmup(count: number, dtSeconds = 1 / 60): void {
      for (let i = 0; i < count; i++) api.step(dtSeconds);
    },

    async captureJPEG(quality = 0.9): Promise<string> {
      return encode(canvas, 'image/jpeg', quality);
    },

    async capturePNG(): Promise<string> {
      return encode(canvas, 'image/png');
    },

    stats(): Record<string, number> {
      return game.stats();
    },

    analyze(): FrameMetrics {
      return analyzeFrame(device, canvas);
    },

    elapsed(): number {
      return game.elapsed;
    },

    frameCount(): number {
      return frames;
    },
  };

  (window as unknown as Record<string, unknown>).__H = api;
}

/**
 * Encodes the canvas to a data URL.
 *
 * `toBlob` is preferred over `toDataURL` because it does the encode off the
 * main thread where the browser supports it; the FileReader round-trip to a
 * data URL is still far cheaper than a CDP screenshot.
 */
async function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
  if (!blob) throw new Error(`Failed to encode canvas as ${type}`);

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
