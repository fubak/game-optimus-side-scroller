/**
 * Animation state probe.
 *
 * Dumps the animator's internal state and resulting bone rotations across a
 * locomotion cycle. Written because the run pose rendered identically to idle,
 * and the rendered image alone cannot distinguish between "the clip is not
 * playing", "the clip is playing but the blend weight is zero", and "the clip
 * is playing but something downstream is overwriting it".
 */

import { launchBrowser, waitForHarness } from './browser.ts';

async function main(): Promise<void> {
  const { page, close } = await launchBrowser('http://127.0.0.1:5173/?harness=1', 480, 360);

  try {
    await waitForHarness(page);

    const result = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const harness = w.__H as {
        setPlayerVelocity(v: number | null): void;
        setCamera(x: number, y: number, h: number): void;
        step(dt?: number): void;
      };
      const game = w.__game as {
        animator: {
          currentState: number;
          skeleton: {
            world: { worldRotation: Float32Array; worldX: Float32Array; worldY: Float32Array };
            index(name: string): number;
          };
          debugSnapshot?(): Record<string, number>;
        };
      };

      const out: Record<string, unknown>[] = [];
      harness.setPlayerVelocity(7.0);
      for (let i = 0; i < 60; i++) harness.step(1 / 60);

      const skeleton = game.animator.skeleton;
      const thighNear = skeleton.index('thighNear');
      const shinNear = skeleton.index('shinNear');
      const thighFar = skeleton.index('thighFar');
      const footNear = skeleton.index('footNear');

      // Sample across roughly one stride.
      for (let i = 0; i < 24; i++) {
        harness.step(1 / 60);
        out.push({
          frame: i,
          state: game.animator.currentState,
          extra: game.animator.debugSnapshot ? game.animator.debugSnapshot() : null,
          thighNearDeg: (skeleton.world.worldRotation[thighNear]! * 180) / Math.PI,
          shinNearDeg: (skeleton.world.worldRotation[shinNear]! * 180) / Math.PI,
          thighFarDeg: (skeleton.world.worldRotation[thighFar]! * 180) / Math.PI,
          footNearY: skeleton.world.worldY[footNear],
          footNearX: skeleton.world.worldX[footNear],
        });
      }
      return out;
    });

    console.log('state: 0=Idle 1=Walk 2=Run 3=JumpRise 4=Fall 5=Land');
    for (const row of result as Record<string, number>[]) {
      console.log(
        `f${String(row.frame).padStart(2)} state=${row.state} ` +
          `thighNear=${row.thighNearDeg!.toFixed(1).padStart(7)}deg ` +
          `shinNear=${row.shinNearDeg!.toFixed(1).padStart(7)}deg ` +
          `thighFar=${row.thighFarDeg!.toFixed(1).padStart(7)}deg ` +
          `footY=${row.footNearY!.toFixed(3)} footX=${row.footNearX!.toFixed(3)}`,
      );
    }
    console.log('\nextra:', JSON.stringify((result as Record<string, unknown>[])[0]?.extra));
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
