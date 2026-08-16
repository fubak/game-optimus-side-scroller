/**
 * Headless traversal check.
 *
 * Plays the traversal input tape and reports the player's trajectory. This
 * answers the question a screenshot cannot: does the level actually *work*? A
 * beautiful room the player falls out of, or a jump that cannot be made, is
 * invisible in a still and obvious here.
 *
 * Exits non-zero if the player fails to reach the far platform, so it can act
 * as a gate.
 */

import { launchBrowser, waitForHarness } from './browser.ts';
import { SCENARIOS } from './scenarios/index.ts';

/** X position the traversal must reach to count as a success. */
const TARGET_X = 70;
/** Y below which the player is considered to have fallen out of the room. */
const FALL_LIMIT = 14;

async function main(): Promise<void> {
  const scenario = SCENARIOS.find((s) => s.name === 'ares_traversal');
  if (!scenario) throw new Error('ares_traversal scenario is missing');

  const { page, close } = await launchBrowser('http://127.0.0.1:5173/?harness=1', 480, 270);

  try {
    await waitForHarness(page);

    const samples = await page.evaluate(
      ([config]) => {
        const harness = (window as unknown as Record<string, unknown>).__H as {
          seed(v: number): void;
          setResolution(w: number, h: number): void;
          setQuality(q: number): void;
          clearCamera(): void;
          autopilot(targetX: number | null, direction?: number, sprint?: boolean): void;
          step(dt?: number): void;
          stats(): Record<string, number>;
        };

        harness.seed(config!.seed);
        harness.setQuality(0);
        harness.setResolution(320, 180);
        harness.clearCamera();
        harness.autopilot(72, 1, true);

        const out: Record<string, number>[] = [];
        const frames = Math.round(config!.duration * 60);
        for (let i = 0; i < frames; i++) {
          harness.step(1 / 60);
          if (i % 6 === 0) {
            const stats = harness.stats();
            out.push({
              t: i / 60,
              x: stats.playerX!,
              y: stats.playerY!,
              vx: stats.playerVX!,
              vy: stats.playerVY!,
              grounded: stats.grounded!,
            });
          }
        }
        return out;
      },
      [{ seed: scenario.seed, duration: scenario.durationSeconds }],
    );

    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let airborneFrames = 0;

    console.log('   t      x       y      vx      vy   grounded');
    for (const sample of samples) {
      maxX = Math.max(maxX, sample.x!);
      minY = Math.min(minY, sample.y!);
      maxY = Math.max(maxY, sample.y!);
      if (!sample.grounded) airborneFrames++;
      console.log(
        `${sample.t!.toFixed(2).padStart(5)} ` +
          `${sample.x!.toFixed(2).padStart(7)} ` +
          `${sample.y!.toFixed(2).padStart(7)} ` +
          `${sample.vx!.toFixed(2).padStart(7)} ` +
          `${sample.vy!.toFixed(2).padStart(7)} ` +
          `${sample.grounded ? '   yes' : '    no'}`,
      );
    }

    console.log('\n--- summary ---');
    console.log(`furthest X reached : ${maxX.toFixed(2)} (target ${TARGET_X})`);
    console.log(`Y range            : ${minY.toFixed(2)} .. ${maxY.toFixed(2)}`);
    console.log(`airborne samples   : ${airborneFrames}/${samples.length}`);

    const fellOut = maxY > FALL_LIMIT;
    const reached = maxX >= TARGET_X;

    if (fellOut) {
      console.error(`\nFAIL: the player fell out of the room (Y reached ${maxY.toFixed(2)})`);
      process.exitCode = 1;
    } else if (!reached) {
      console.error(
        `\nFAIL: the traversal stalled at X=${maxX.toFixed(2)}, short of ${TARGET_X}. ` +
          'Either a jump is not achievable or the tape timing is wrong.',
      );
      process.exitCode = 1;
    } else {
      console.log('\nPASS: the room is traversable with the scripted input.');
    }
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
