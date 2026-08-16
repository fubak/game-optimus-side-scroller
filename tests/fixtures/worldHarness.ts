import { ScriptedInput, buildTape } from '../../src/core/input';
import type { Input, TapeSpan } from '../../src/core/input';
import { parseLevel } from '../../src/game/levelParser';
import type { LevelDef } from '../../src/game/levelParser';
import { World } from '../../src/game/world';
import type { WorldEvent, WorldOptions } from '../../src/game/world';
import { Autopilot } from '../../src/game/autopilot';

export const DT = 1 / 60;

export interface WorldRun {
  readonly world: World;
  readonly events: WorldEvent[];
  readonly frames: number;
}

export interface RunWorldOptions extends WorldOptions {
  readonly frames?: number;
  readonly spans?: readonly TapeSpan[];
  /** Stop as soon as the world finishes (level complete or run out of lives). */
  readonly stopWhenFinished?: boolean;
  readonly onFrame?: (world: World, frame: number) => void;
}

/** Drive a world with a scripted input tape. */
export function runWorldWithTape(def: LevelDef, options: RunWorldOptions = {}): WorldRun {
  const input = new ScriptedInput(buildTape(options.spans ?? []));
  return runWorld(def, input, options);
}

/** Drive a world with the greedy platforming bot (proves a level is traversable). */
export function runWorldWithBot(def: LevelDef, options: RunWorldOptions = {}): WorldRun {
  const world = createWorld(def, options);
  const bot = new Autopilot(world);
  return stepWorld(world, bot, options);
}

export function createWorld(def: LevelDef, options: WorldOptions = {}): World {
  return new World(parseLevel(def), options);
}

function runWorld(def: LevelDef, input: Input, options: RunWorldOptions): WorldRun {
  const world = createWorld(def, options);
  return stepWorld(world, input, options);
}

function stepWorld(world: World, input: Input, options: RunWorldOptions): WorldRun {
  const events: WorldEvent[] = [];
  const frames = options.frames ?? 60 * 60;
  let executed = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    events.push(...world.update(DT, input));
    input.endFrame();
    options.onFrame?.(world, frame);
    executed = frame + 1;
    if (options.stopWhenFinished === true && world.isFinished) break;
  }
  return { world, events, frames: executed };
}

export function eventTypes(run: WorldRun): string[] {
  return run.events.map((event) => event.type);
}

export function countEventType(run: WorldRun, type: WorldEvent['type']): number {
  return run.events.filter((event) => event.type === type).length;
}
