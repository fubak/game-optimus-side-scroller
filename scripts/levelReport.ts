/**
 * Level report / linter.
 *
 * `npx vite-node scripts/levelReport.ts` prints every shipped level with column rulers and flags
 * layout problems that are easy to create by hand and hard to see in a wall of ASCII:
 *
 * - rows of differing length (a one-character typo silently shifts an entire row)
 * - floor gaps wider than Optimus can jump
 * - steps taller than Optimus can climb
 * - pickups or spawns embedded in solid tiles
 *
 * The same checks run in the unit tests (`tests/unit/levelLint.test.ts`); this script is the
 * human-readable version used while authoring.
 */
import { LEVELS } from '../src/game/levels/index';
import { auditLevel, MAX_GAP_TILES, MAX_STEP_TILES } from '../src/game/levelAudit';
import { parseLevel } from '../src/game/levelParser';

function ruler(width: number): string {
  let tens = '';
  let ones = '';
  for (let i = 0; i < width; i += 1) {
    tens += i % 10 === 0 ? String(Math.floor(i / 10) % 10) : ' ';
    ones += String(i % 10);
  }
  return `${tens}\n${ones}`;
}

let failures = 0;
for (const def of LEVELS) {
  const level = parseLevel(def);
  const report = auditLevel(level);
  console.log(`\n=== ${def.id} — ${def.name} (${String(level.map.width)}×${String(level.map.height)}) ===`);
  console.log(ruler(level.map.width));
  def.rows.forEach((row, index) => {
    console.log(`${row.padEnd(level.map.width, '.')} | ${String(index).padStart(2)}`);
  });
  console.log(
    `spawn tile (${String(Math.floor(level.spawnX / 16))}, ${String(Math.floor(level.spawnY / 16))})`,
    `goals: ${String(level.goals.length)}`,
    `checkpoints: ${String(level.checkpoints.length)}`,
    `collectables: ${String(level.collectableCount)}`,
  );
  console.log(`limits: max gap ${String(MAX_GAP_TILES)} tiles, max step ${String(MAX_STEP_TILES)} tiles`);
  if (report.problems.length === 0) {
    console.log('OK — no layout problems found');
  } else {
    failures += report.problems.length;
    for (const problem of report.problems) {
      console.log(`PROBLEM: ${problem}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${String(failures)} layout problem(s) found.`);
  process.exitCode = 1;
}
