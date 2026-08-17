/**
 * Frame-time benchmark harness (`npm run bench`).
 *
 * Boots the production build (`dist/`, from `npm run build`) in a real headless Chromium via
 * Playwright, plays `level-1` with the deterministic autopilot (`?autoplay=1&seed=...`) so every
 * run exercises the same camera path through the level, at three viewport sizes standing in for
 * common display resolutions (1080p/1440p/4K) crossed with three quality presets, and prints
 * p50/p95/p99 real-world animation-frame times plus an average FPS for each combination.
 *
 * Frame times come straight from `window.__optimus.frameSamples()` — a small ring buffer
 * `src/main.ts` fills once per real `requestAnimationFrame` tick (see `src/core/testHooks.ts`), so
 * the numbers reflect actual browser frame pacing rather than the fixed-timestep simulation rate.
 *
 * Best-effort by design (see `docs/bench/README.md`): missing Chromium, a missing `dist/` build,
 * or any other failure prints a skip message and exits `0` rather than failing the caller. This
 * script is deliberately not part of `npm run ci`.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

interface Resolution {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const RESOLUTIONS: readonly Resolution[] = [
  { name: '1080p', width: 1920, height: 1080 },
  { name: '1440p', width: 2560, height: 1440 },
  { name: '4K', width: 3840, height: 2160 },
];

type QualityPreset = 'medium' | 'high' | 'ultra';
const QUALITIES: readonly QualityPreset[] = ['medium', 'high', 'ultra'];

const LEVEL_ID = 'level-1';
const SEED = 1234;
const WARMUP_MS = 1500;
const SAMPLE_MS = 4000;
const PREVIEW_PORT = 4174; // distinct from the e2e suite's :4173 so both can run side by side
const PREVIEW_URL = `http://127.0.0.1:${String(PREVIEW_PORT)}`;
const SERVER_TIMEOUT_MS = 20_000;

interface FrameStats {
  readonly resolution: string;
  readonly quality: QualityPreset;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly avgFps: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not up yet — keep polling until the deadline.
    }
    await sleep(200);
  }
  throw new Error(`Preview server at ${url} did not respond within ${String(timeoutMs)}ms.`);
}

async function measure(page: Page, resolution: Resolution, quality: QualityPreset): Promise<FrameStats> {
  await page.setViewportSize({ width: resolution.width, height: resolution.height });
  await page.goto(
    `${PREVIEW_URL}/?test=1&renderer=webgl2&quality=${quality}&autoplay=1&level=${LEVEL_ID}&seed=${String(SEED)}`,
  );
  await page.waitForFunction(() => window.__optimus !== undefined);
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => {
    window.__optimus?.resetFrameSamples();
  });
  await page.waitForTimeout(SAMPLE_MS);
  const raw = await page.evaluate(() => window.__optimus?.frameSamples() ?? []);
  const samples = [...raw].sort((a, b) => a - b);
  const totalMs = samples.reduce((sum, ms) => sum + ms, 0);
  const avgFps = samples.length === 0 ? 0 : 1000 / (totalMs / samples.length);
  return {
    resolution: resolution.name,
    quality,
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    avgFps,
  };
}

function printReport(results: readonly FrameStats[]): void {
  console.log('\nresolution  quality  samples     p50ms     p95ms     p99ms   avgFPS');
  for (const r of results) {
    console.log(
      `${r.resolution.padEnd(10)}  ${r.quality.padEnd(7)}  ${String(r.samples).padStart(7)}  ` +
        `${r.p50.toFixed(2).padStart(8)}  ${r.p95.toFixed(2).padStart(8)}  ${r.p99.toFixed(2).padStart(8)}  ` +
        `${r.avgFps.toFixed(1).padStart(7)}`,
    );
  }
}

function writeResults(results: readonly FrameStats[]): string {
  const outPath = fileURLToPath(new URL('../docs/bench/results.json', import.meta.url));
  mkdirSync(dirname(outPath), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    level: LEVEL_ID,
    seed: SEED,
    warmupMs: WARMUP_MS,
    sampleMs: SAMPLE_MS,
    results,
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

function skip(reason: string): void {
  console.log(`[bench] Skipping — ${reason}`);
  process.exitCode = 0;
}

async function run(): Promise<void> {
  const distIndex = fileURLToPath(new URL('../dist/index.html', import.meta.url));
  if (!existsSync(distIndex)) {
    skip('no production build found (run `npm run build` first).');
    return;
  }

  let preview: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
      stdio: 'ignore',
    });
    await waitForServer(PREVIEW_URL, SERVER_TIMEOUT_MS);

    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dbus'] });
    const page = await browser.newPage();

    const results: FrameStats[] = [];
    for (const resolution of RESOLUTIONS) {
      for (const quality of QUALITIES) {
        console.log(`Benchmarking ${resolution.name} (${String(resolution.width)}x${String(resolution.height)}) @ ${quality}...`);
        results.push(await measure(page, resolution, quality));
      }
    }

    printReport(results);
    const outPath = writeResults(results);
    console.log(`\nWrote ${outPath}`);
  } catch (error) {
    skip(`could not run the browser benchmark (${error instanceof Error ? error.message : String(error)}).`);
  } finally {
    await browser?.close();
    preview?.kill();
  }
}

await run();
