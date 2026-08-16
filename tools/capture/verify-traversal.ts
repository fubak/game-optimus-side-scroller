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

import type { Page } from 'playwright-core';
import { launchBrowser, waitForHarness } from './browser.ts';
import { SCENARIOS } from './scenarios/index.ts';

/** Per-biome traversal targets. */
const BIOME_CONFIG = [
  { name: 'Ares Basin', biome: 0, targetX: 70, autopilotX: 72, fallLimit: 14, duration: 28 },
  { name: 'The Foundry', biome: 1, targetX: 84, autopilotX: 86, fallLimit: 2, duration: 30 },
] as const;

async function main(): Promise<void> {
  const scenario = SCENARIOS.find((s) => s.name === 'ares_traversal');
  if (!scenario) throw new Error('ares_traversal scenario is missing');

  const only = process.argv.includes('--biome')
    ? Number(process.argv[process.argv.indexOf('--biome') + 1])
    : null;

  const { page, close } = await launchBrowser('http://127.0.0.1:5173/?harness=1', 480, 270);

  try {
    await waitForHarness(page);

    let anyFailed = false;
    for (const config of BIOME_CONFIG) {
      if (only !== null && config.biome !== only) continue;
      console.log(`\n=== ${config.name} ===`);
      const failed = await runBiome(page, scenario.seed, config);
      if (failed) anyFailed = true;
    }
    if (anyFailed) process.exitCode = 1;
  } finally {
    await close();
  }
}

async function runBiome(
  page: Page,
  seed: number,
  config: (typeof BIOME_CONFIG)[number],
): Promise<boolean> {
  {

    const samples = await page.evaluate(
      (configs: { seed: number; duration: number; biome: number; autopilotX: number }[]) => {
        const config = configs[0]!;
        const harness = (window as unknown as Record<string, unknown>).__H as {
          seed(v: number): void;
          setResolution(w: number, h: number): void;
          setQuality(q: number): void;
          clearCamera(): void;
          setBiome(id: number): void;
          autopilot(targetX: number | null, direction?: number, sprint?: boolean): void;
          step(dt?: number): void;
          stats(): Record<string, number>;
        };

        harness.seed(config.seed);
        harness.setQuality(0);
        harness.setResolution(320, 180);
        if (config.biome > 0) harness.setBiome(config.biome);
        harness.clearCamera();
        harness.autopilot(config.autopilotX, 1, true);
        // Match the recorder's warmup exactly. Without it the gate exercises a
        // slightly different simulation than the one being recorded, and a
        // fall that soft-locked the demo passed the gate cleanly.
        for (let i = 0; i < 30; i++) harness.step(1 / 60);

        const out: Record<string, number>[] = [];
        const frames = Math.round(config.duration * 60);
        for (let i = 0; i < frames; i++) {
          harness.step(1 / 60);
          if (i % 6 === 0) {
            const stats = harness.stats();
            out.push({
              t: i / 60,
              respawns: stats.respawns!,
              x: stats.playerX!,
              y: stats.playerY!,
              vx: stats.playerVX!,
              vy: stats.playerVY!,
              grounded: stats.grounded!,
              enemies: stats.enemies!,
              health: stats.playerHealth!,
              particles: stats.particles!,
            });
          }
        }
        return out;
      },
      [{ seed, duration: config.duration, biome: config.biome, autopilotX: config.autopilotX }],
    );

    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let airborneFrames = 0;
    let peakParticles = 0;

    if (process.env.VERBOSE) {
      console.log('   t      x       y      vx      vy   grounded');
    }
    for (const sample of samples) {
      maxX = Math.max(maxX, sample.x!);
      minY = Math.min(minY, sample.y!);
      maxY = Math.max(maxY, sample.y!);
      if (!sample.grounded) airborneFrames++;
      peakParticles = Math.max(peakParticles, sample.particles!);
      if (process.env.VERBOSE) {
        console.log(
          `${sample.t!.toFixed(2).padStart(5)} ` +
            `${sample.x!.toFixed(2).padStart(7)} ` +
            `${sample.y!.toFixed(2).padStart(7)} ` +
            `${sample.vx!.toFixed(2).padStart(7)} ` +
            `${sample.vy!.toFixed(2).padStart(7)} ` +
            `${sample.grounded ? '   yes' : '    no'} ` +
            `enemies=${sample.enemies} hp=${sample.health}`,
        );
      }
    }

    console.log('--- summary ---');
    console.log(`furthest X reached : ${maxX.toFixed(2)} (target ${config.targetX})`);
    console.log(`Y range            : ${minY.toFixed(2)} .. ${maxY.toFixed(2)}`);
    console.log(`airborne samples   : ${airborneFrames}/${samples.length}`);

    const first = samples[0] as Record<string, number> | undefined;
    const last = samples[samples.length - 1] as Record<string, number> | undefined;
    const startEnemies = first?.enemies ?? 0;
    const endEnemies = last?.enemies ?? 0;
    console.log(`enemies            : ${startEnemies} -> ${endEnemies} (${startEnemies - endEnemies} defeated)`);
    console.log(`player health      : ${first?.health ?? 0} -> ${last?.health ?? 0}`);
    console.log(`peak particles     : ${peakParticles}`);
    console.log(`respawns           : ${last?.respawns ?? 0}`);

    const fellOut = maxY > config.fallLimit;
    const reached = maxX >= config.targetX;

    if (fellOut) {
      console.error(`FAIL: the player fell out of the room (Y reached ${maxY.toFixed(2)})`);
      return true;
    } else if (!reached) {
      console.error(
        `FAIL: the traversal stalled at X=${maxX.toFixed(2)}, short of ${config.targetX}. ` +
          'The route is probably not achievable as laid out.',
      );
      return true;
    } else {
      const defeated = startEnemies - endEnemies;
      if (defeated === 0) {
        console.error('FAIL: reached the exit but defeated no enemies. Combat is not connecting.');
        return true;
      }
      console.log(`PASS: room traversed and ${defeated} enemies defeated.`);
    }
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
