import { ScriptedInput, buildTape } from '../../src/core/input';
import type { TapeSpan } from '../../src/core/input';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/game/constants';
import { Player } from '../../src/game/player';
import type { PlayerEvent } from '../../src/game/player';
import type { TileMap } from '../../src/game/tilemap';
import { mapFromAscii } from './maps';

export const DT = 1 / 60;

/** Flat floor with plenty of room above, used by most movement tests. */
export const FLAT_GROUND: readonly string[] = [
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '########################',
];

export interface PlayerRun {
  readonly player: Player;
  readonly map: TileMap;
  readonly input: ScriptedInput;
  readonly events: PlayerEvent[];
  /** Per-frame samples, index === frame. */
  readonly samples: PlayerSample[];
}

export interface PlayerSample {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly state: string;
  readonly grounded: boolean;
  readonly energy: number;
  readonly health: number;
}

export interface RunOptions {
  readonly rows?: readonly string[];
  readonly spans?: readonly TapeSpan[];
  readonly frames?: number;
  readonly spawnTile?: readonly [number, number];
  /** Called after each frame, e.g. to inject damage at a specific moment. */
  readonly onFrame?: (run: PlayerRun, frame: number) => void;
}

/**
 * Run the player through a tilemap with a scripted input tape and record every frame.
 *
 * This is the workhorse of the player tests: because the simulation is fixed-step and input comes
 * from a tape, the resulting sample list is fully deterministic.
 */
export function runPlayer(options: RunOptions = {}): PlayerRun {
  const map = mapFromAscii(options.rows ?? FLAT_GROUND);
  const input = new ScriptedInput(buildTape(options.spans ?? []));
  const [spawnTileX, spawnTileY] = options.spawnTile ?? [1, 5];
  // `spawnTile` is the tile the player's feet occupy: the body sits flush on that cell's bottom
  // edge, so it rests on whatever tile is directly below (never embedded inside a solid).
  const player = new Player(
    spawnTileX * map.tileSize + (map.tileSize - PLAYER_WIDTH) / 2,
    (spawnTileY + 1) * map.tileSize - PLAYER_HEIGHT,
  );
  const events: PlayerEvent[] = [];
  const samples: PlayerSample[] = [];
  const run: PlayerRun = { player, map, input, events, samples };

  const frames = options.frames ?? 120;
  for (let frame = 0; frame < frames; frame += 1) {
    player.update(DT, input, map, events);
    samples.push({
      frame,
      x: player.body.x,
      y: player.body.y,
      vx: player.body.vx,
      vy: player.body.vy,
      state: player.state,
      grounded: player.isOnGround,
      energy: player.energy,
      health: player.health,
    });
    input.endFrame();
    options.onFrame?.(run, frame);
  }
  return run;
}

/** Highest point (smallest y) reached during a run. */
export function peakHeight(run: PlayerRun): number {
  return Math.min(...run.samples.map((sample) => sample.y));
}

export function eventTypes(run: PlayerRun): string[] {
  return run.events.map((event) => event.type);
}

export function countEvents(run: PlayerRun, type: PlayerEvent['type']): number {
  return run.events.filter((event) => event.type === type).length;
}
