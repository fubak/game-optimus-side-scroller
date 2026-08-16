/**
 * Dumps every intermediate pipeline buffer as a still.
 *
 * When the final image looks wrong it is almost never obvious which stage is at
 * fault — a black screen could be an empty G-buffer, a broken lighting pass, or
 * an over-aggressive tonemap. Rendering each buffer in isolation turns that
 * guesswork into a five-second check, which matters enormously on a headless
 * machine where there is no devtools frame debugger to reach for.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchBrowser, waitForHarness } from './browser.ts';

const ROOT = resolve(import.meta.dirname, '../..');

const VIEWS: { id: number; name: string; note: string }[] = [
  // View 0 is the fully composited image. Having it here makes this tool a
  // ~8 second preview of a tuning change, against ~60 seconds to record a clip.
  { id: 0, name: 'final', note: 'fully composited frame' },
  { id: 1, name: 'albedo', note: 'base colour, no lighting' },
  { id: 2, name: 'normal', note: 'RG = normal xy, B = height, A = AO' },
  { id: 3, name: 'material', note: 'R = roughness, G = metallic, B = emissive' },
  { id: 4, name: 'depth', note: 'R = parallax depth' },
  { id: 5, name: 'occluder', note: 'shadow-caster coverage mask' },
  { id: 6, name: 'light', note: 'HDR light accumulation' },
  { id: 7, name: 'godrays', note: 'volumetric light shafts' },
  { id: 8, name: 'bloom', note: 'bloom chain level 0' },
  { id: 10, name: 'scene', note: 'post-fog HDR scene, pre-composite' },
  { id: 11, name: 'contactAO', note: 'contact occlusion pools' },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : fallback;
  };

  const width = Number(get('--width', '960'));
  const height = Number(get('--height', '540'));
  const url = get('--url', 'http://127.0.0.1:5173');
  const outputDir = join(ROOT, get('--out', 'progress/media/debug'));

  mkdirSync(outputDir, { recursive: true });

  const { page, close } = await launchBrowser(`${url}/?harness=1`, width, height);

  try {
    await waitForHarness(page);

    await page.evaluate(
      ([w, h]) => {
        const harness = (window as unknown as Record<string, unknown>).__H as {
          seed(v: number): void;
          setResolution(w: number, h: number): void;
          setQuality(q: number): void;
          warmup(n: number): void;
        };
        harness.seed(1001);
        harness.setQuality(3);
        harness.setResolution(w!, h!);
        harness.warmup(45);
      },
      [width, height],
    );

    for (const view of VIEWS) {
      const png: string = await page.evaluate(async (id) => {
        const harness = (window as unknown as Record<string, unknown>).__H as {
          setDebugView(v: number): void;
          step(dt?: number): void;
          capturePNG(): Promise<string>;
        };
        harness.setDebugView(id);
        harness.step(1 / 60);
        return harness.capturePNG();
      }, view.id);

      const comma = png.indexOf(',');
      const buffer = Buffer.from(png.slice(comma + 1), 'base64');
      const path = join(outputDir, `${String(view.id).padStart(2, '0')}_${view.name}.png`);
      writeFileSync(path, buffer);
      console.log(`wrote ${path}  (${view.note})`);
    }

    // Restore the normal view so a subsequent capture in the same session is
    // not silently left rendering a debug buffer.
    await page.evaluate(() => {
      const harness = (window as unknown as Record<string, unknown>).__H as {
        setDebugView(v: number): void;
      };
      harness.setDebugView(0);
    });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
