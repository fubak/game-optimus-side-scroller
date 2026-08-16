/**
 * Scenario recorder.
 *
 * Loads the game in a headless browser, drives it frame by frame on a virtual
 * clock, and writes out hero stills, an mp4, and a metrics report.
 *
 * Usage:
 *   npm run capture -- --scenario ares_vista
 *   npm run capture -- --all
 *   npm run capture -- --scenario combat --width 1280 --height 720
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchBrowser, waitForHarness } from './browser.ts';
import { SCENARIOS, type Scenario } from './scenarios/index.ts';
import type { Page } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT_ROOT = join(ROOT, 'progress', 'media');
const FRAME_ROOT = join(ROOT, 'tmp-frames');

interface Options {
  scenarios: Scenario[];
  width: number;
  height: number;
  heroWidth: number;
  heroHeight: number;
  serverUrl: string;
  outputDir: string;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
  };

  const wanted = get('--scenario');
  const all = argv.includes('--all');

  let scenarios: Scenario[];
  if (all || !wanted) {
    scenarios = SCENARIOS;
  } else {
    const names = wanted.split(',').map((s) => s.trim());
    scenarios = names.map((name) => {
      const found = SCENARIOS.find((s) => s.name === name);
      if (!found) {
        throw new Error(
          `Unknown scenario "${name}". Available: ${SCENARIOS.map((s) => s.name).join(', ')}`,
        );
      }
      return found;
    });
  }

  return {
    scenarios,
    // 960x540 for video: measured at roughly 0.3 s per frame on the software
    // rasteriser, so a 10 s clip records in about three minutes.
    width: Number(get('--width', '960')),
    height: Number(get('--height', '540')),
    // Stills are worth the extra cost; critics look at these closely.
    heroWidth: Number(get('--hero-width', '1600')),
    heroHeight: Number(get('--hero-height', '900')),
    serverUrl: get('--url', 'http://127.0.0.1:5173')!,
    outputDir: get('--out', OUTPUT_ROOT)!,
  };
}

/** Strips the `data:image/...;base64,` prefix and decodes. */
function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

async function runScenario(page: Page, scenario: Scenario, options: Options): Promise<void> {
  console.log(`\n=== ${scenario.name} ===`);
  console.log(`    ${scenario.description}`);

  const frameDir = join(FRAME_ROOT, scenario.name);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  mkdirSync(options.outputDir, { recursive: true });

  // ---- Configure the scene ------------------------------------------------
  await page.evaluate(
    ([config]) => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        seed(v: number): void;
        setQuality(q: number): void;
        setResolution(w: number, h: number): void;
        setDebugView(v: number): void;
        playTape(t: unknown[]): void;
        clearTape(): void;
      };
      harness.seed(config!.seed);
      harness.setQuality(config!.quality);
      harness.setResolution(config!.width, config!.height);
      harness.setDebugView(config!.debugView);
      if (config!.tape.length > 0) harness.playTape(config!.tape);
      else harness.clearTape();
    },
    [
      {
        seed: scenario.seed,
        quality: scenario.quality,
        width: options.width,
        height: options.height,
        debugView: scenario.debugView ?? 0,
        tape: scenario.tape ?? [],
      },
    ],
  );

  // ---- Settle ------------------------------------------------------------
  // Ambient systems (drifting dust, flickering lights, camera smoothing) need a
  // moment to reach a representative state; recording from frame zero would
  // capture a scene mid-initialisation.
  const warmupFrames = scenario.warmupFrames ?? 30;
  console.log(`    warming up ${warmupFrames} frames...`);
  await page.evaluate((frames) => {
    const harness = (window as unknown as Record<string, unknown>).__H as {
      warmup(n: number): void;
    };
    harness.warmup(frames);
  }, warmupFrames);

  // ---- Record ------------------------------------------------------------
  const totalFrames = Math.round(scenario.durationSeconds * 60);
  const batchSize = 30;
  let written = 0;
  const startedAt = Date.now();

  for (let start = 0; start < totalFrames; start += batchSize) {
    const count = Math.min(batchSize, totalFrames - start);

    // Stepping and encoding happen entirely inside the page, and only the
    // finished JPEGs cross the CDP boundary. Round-tripping per frame was
    // measured at 3.1 s versus 33 ms for this approach.
    const batch: string[] = await page.evaluate(async (n) => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        step(dt?: number): void;
        captureJPEG(q?: number): Promise<string>;
      };
      const frames: string[] = [];
      for (let i = 0; i < n; i++) {
        harness.step(1 / 60);
        frames.push(await harness.captureJPEG(0.92));
      }
      return frames;
    }, count);

    for (const dataUrl of batch) {
      const path = join(frameDir, `frame_${String(written).padStart(5, '0')}.jpg`);
      writeFileSync(path, decodeDataUrl(dataUrl));
      written++;
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = written / Math.max(elapsed, 0.001);
    const remaining = (totalFrames - written) / Math.max(rate, 0.001);
    process.stdout.write(
      `\r    recorded ${written}/${totalFrames} frames ` +
        `(${rate.toFixed(1)} fps, ~${remaining.toFixed(0)}s remaining)   `,
    );
  }
  process.stdout.write('\n');

  // ---- Metrics -----------------------------------------------------------
  const metrics = await page.evaluate(() => {
    const harness = (window as unknown as Record<string, unknown>).__H as {
      analyze(): unknown;
      stats(): unknown;
    };
    return { image: harness.analyze(), stats: harness.stats() };
  });

  writeFileSync(
    join(options.outputDir, `${scenario.name}.metrics.json`),
    JSON.stringify({ scenario: scenario.name, ...metrics }, null, 2),
  );

  // ---- Hero stills -------------------------------------------------------
  console.log('    capturing hero stills...');
  await page.evaluate(
    ([w, h]) => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        setResolution(w: number, h: number): void;
      };
      harness.setResolution(w!, h!);
    },
    [options.heroWidth, options.heroHeight],
  );

  const heroTimes = scenario.heroFrames ?? [scenario.durationSeconds * 0.5];
  for (let i = 0; i < heroTimes.length; i++) {
    const png: string = await page.evaluate(async () => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        step(dt?: number): void;
        capturePNG(): Promise<string>;
      };
      // One step so the resize is reflected in a freshly rendered frame.
      harness.step(1 / 60);
      return harness.capturePNG();
    });
    const path = join(options.outputDir, `${scenario.name}_hero${i}.png`);
    writeFileSync(path, decodeDataUrl(png));
    console.log(`    wrote ${path}`);
  }

  // ---- Encode ------------------------------------------------------------
  const videoPath = join(options.outputDir, `${scenario.name}.mp4`);
  encodeVideo(frameDir, videoPath);

  rmSync(frameDir, { recursive: true, force: true });
}

/**
 * Encodes recorded frames into an mp4.
 *
 * `yuv420p` and the even-dimension scale filter are required for the file to
 * play in browsers and QuickTime; without them the video is technically valid
 * but will not play where it needs to.
 */
function encodeVideo(frameDir: string, outputPath: string): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      '60',
      '-i',
      join(frameDir, 'frame_%05d.jpg'),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.error(result.stderr?.slice(-2000));
    throw new Error(`ffmpeg failed with status ${result.status}`);
  }
  console.log(`    wrote ${outputPath}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(FRAME_ROOT)) mkdirSync(FRAME_ROOT, { recursive: true });

  const url = `${options.serverUrl}/?harness=1`;
  console.log(`Launching headless Chrome against ${url}`);

  const { page, close } = await launchBrowser(url, options.width, options.height);

  try {
    await waitForHarness(page);
    console.log('Harness ready.');

    for (const scenario of options.scenarios) {
      await runScenario(page, scenario, options);
    }
  } finally {
    await close();
  }

  console.log('\nDone.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
