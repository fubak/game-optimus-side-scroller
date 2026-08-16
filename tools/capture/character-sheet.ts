/**
 * Character inspection sheet.
 *
 * Renders Optimus close up at several locomotion speeds and writes one still
 * per pose. Judging a 1.7 m character inside an 11 m frame is guesswork; at
 * this framing the rig's construction, proportions, joint placement, and
 * silhouette are all directly readable.
 *
 * This is the fastest possible feedback loop for character work, and it exists
 * because the first full-scene capture showed something was wrong with the legs
 * but was far too small to show *what*.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, waitForHarness } from './browser.ts';

const ROOT = resolve(import.meta.dirname, '../..');

interface Shot {
  name: string;
  /** Held horizontal input in [-1, 1]. */
  moveX: number;
  /** Whether to hold the sprint button. */
  sprint: boolean;
  /** Frames to settle before capturing, so a cycle reaches a stable phase. */
  settle: number;
  viewHeight: number;
  debugView?: number;
}

const SHOTS: Shot[] = [
  { name: 'idle', moveX: 0, sprint: false, settle: 45, viewHeight: 2.6 },
  { name: 'walk', moveX: 0.55, sprint: false, settle: 70, viewHeight: 2.6 },
  { name: 'run', moveX: 1, sprint: true, settle: 70, viewHeight: 2.6 },
  { name: 'idle_wide', moveX: 0, sprint: false, settle: 45, viewHeight: 5.0 },
  { name: 'run_wide', moveX: 1, sprint: true, settle: 70, viewHeight: 5.0 },
  // The albedo view isolates the artwork from the lighting, which is the only
  // way to tell a modelling problem from a lighting problem.
  { name: 'idle_albedo', moveX: 0, sprint: false, settle: 45, viewHeight: 2.6, debugView: 1 },
  { name: 'idle_normal', moveX: 0, sprint: false, settle: 45, viewHeight: 2.6, debugView: 2 },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : fallback;
  };

  const width = Number(get('--width', '480'));
  const height = Number(get('--height', '620'));
  const url = get('--url', 'http://127.0.0.1:5173');
  const outputDir = join(ROOT, get('--out', 'progress/media/character'));

  mkdirSync(outputDir, { recursive: true });

  const { page, close } = await launchBrowser(`${url}/?harness=1`, width, height);

  try {
    await waitForHarness(page);

    await page.evaluate(
      ([w, h]) => {
        const harness = (window as unknown as Record<string, unknown>).__H as {
          seed(v: number): void;
          setQuality(q: number): void;
          setResolution(w: number, h: number): void;
        };
        harness.seed(2024);
        harness.setQuality(3);
        harness.setResolution(w!, h!);
      },
      [width, height],
    );

    for (const shot of SHOTS) {
      const png: string = await page.evaluate(async (config) => {
        const harness = (window as unknown as Record<string, unknown>).__H as {
          playTape(t: unknown[]): void;
          teleport(x: number, y: number): void;
          setCamera(x: number, y: number, viewHeight: number): void;
          setDebugView(v: number): void;
          step(dt?: number): void;
          capturePNG(): Promise<string>;
        };
        // Action.Dash is 5; holding it makes the controller sprint.
        harness.playTape([
          { time: 0, moveX: config!.moveX, held: config!.sprint ? [5] : [] },
        ]);
        // Reset to flat open ground so a shot cannot be spoiled by terrain.
        harness.teleport(-20, 0);
        // Frame on the character's centre of mass rather than its feet.
        harness.setCamera(0, -config!.viewHeight * 0.34, config!.viewHeight);
        harness.setDebugView(config!.debugView ?? 0);
        for (let i = 0; i < config!.settle; i++) harness.step(1 / 60);
        return harness.capturePNG();
      }, shot);

      const comma = png.indexOf(',');
      writeFileSync(
        join(outputDir, `${shot.name}.png`),
        Buffer.from(png.slice(comma + 1), 'base64'),
      );
      console.log(`wrote ${shot.name}.png`);
    }

    await page.evaluate(() => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        setDebugView(v: number): void;
        clearTape(): void;
      };
      harness.setDebugView(0);
      harness.clearTape();
    });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
