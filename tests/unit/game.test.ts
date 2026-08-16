import { describe, expect, it } from 'vitest';
import { NullAudio } from '../../src/core/audio';
import type { Audio, SoundName } from '../../src/core/audio';
import { ScriptedInput, buildTape } from '../../src/core/input';
import type { Action, Input } from '../../src/core/input';
import { loadSave, memoryStorage } from '../../src/core/storage';
import type { StorageLike } from '../../src/core/storage';
import { Autopilot } from '../../src/game/autopilot';
import { Game } from '../../src/game/game';
import type { GameOptions } from '../../src/game/game';
import { LEVELS } from '../../src/game/levels/index';

const DT = 1 / 60;

/** Input source whose held actions can be poked directly, like a person at a keyboard. */
class FakeInput implements Input {
  private readonly held = new Set<Action>();
  private readonly pressed = new Set<Action>();

  press(action: Action): void {
    this.held.add(action);
    this.pressed.add(action);
  }

  release(action: Action): void {
    this.held.delete(action);
  }

  tap(action: Action): void {
    this.press(action);
  }

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  justPressed(action: Action): boolean {
    return this.pressed.has(action);
  }

  justReleased(): boolean {
    return false;
  }

  anyJustPressed(): boolean {
    return this.pressed.size > 0;
  }

  endFrame(): void {
    this.pressed.clear();
    // Taps only last a frame.
    for (const action of [...this.held]) {
      if (
        action === 'confirm' ||
        action === 'back' ||
        action === 'pause' ||
        action === 'up' ||
        action === 'down'
      ) {
        this.held.delete(action);
      }
    }
  }
}

/** Records every sound the game asks for. */
class RecordingAudio extends NullAudio {
  readonly played: SoundName[] = [];
  music = false;

  override play(sound: SoundName): void {
    this.played.push(sound);
  }

  override setMusic(enabled: boolean): void {
    this.music = enabled;
  }
}

function createGame(options: Partial<GameOptions> = {}): {
  game: Game;
  storage: StorageLike;
  audio: RecordingAudio;
} {
  const storage = options.storage ?? memoryStorage();
  const audio = (options.audio as RecordingAudio | undefined) ?? new RecordingAudio();
  const game = new Game({ ...options, storage, audio });
  return { game, storage, audio };
}

function step(game: Game, input: Input, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) {
    game.update(DT, input);
  }
}

/**
 * Tap a menu key and let the menu cooldown lapse.
 *
 * Menus rate-limit confirms so a single physical press cannot cascade through two screens; pressing
 * on consecutive frames is not something a human can do anyway.
 */
function menuTap(game: Game, input: FakeInput, action: Action): void {
  input.tap(action);
  step(game, input, 12);
}

/** Play the current level with the autopilot until it finishes or the budget runs out. */
function autoplayLevel(game: Game, maxFrames = 60 * 120): void {
  const world = game.world;
  if (world === null) throw new Error('No world to autoplay.');
  const pilot = new Autopilot(world);
  for (let frame = 0; frame < maxFrames; frame += 1) {
    game.update(DT, pilot);
    if (game.scene.name !== 'playing') return;
  }
  throw new Error('Autopilot did not finish the level in time.');
}

describe('Game — boot and flow', () => {
  it('boots to the title screen with attract mode running behind it', () => {
    const { game } = createGame();
    expect(game.scene.name).toBe('title');
    expect(game.world).toBeNull();
    expect(game.attractWorld).not.toBeNull();

    const before = game.attractWorld?.player.body.x ?? 0;
    step(game, new ScriptedInput([]), 90);
    // The autopilot is playing the demo, so the attract world advances on its own.
    expect(game.attractWorld?.player.body.x ?? 0).toBeGreaterThan(before);
  });

  it('starts the first level from the title menu', () => {
    const { game, audio } = createGame();
    const input = new FakeInput();
    input.tap('confirm');
    step(game, input, 1);
    expect(game.scene.name).toBe('playing');
    expect(game.world).not.toBeNull();
    expect(game.attractWorld).toBeNull();
    expect(audio.music).toBe(true);
    expect(audio.played).toContain('menuConfirm');
  });

  it('can start a level directly (deep link)', () => {
    const { game } = createGame({ startLevelIndex: 1 });
    expect(game.scene.name).toBe('playing');
    expect(game.levelDef?.id).toBe(LEVELS[1]?.id);
  });

  it('pauses, resumes and restarts', () => {
    const { game } = createGame({ startLevelIndex: 0 });
    const input = new FakeInput();
    step(game, input, 30);

    menuTap(game, input, 'pause');
    expect(game.scene.name).toBe('paused');

    // The world stops advancing while paused.
    const frozenX = game.world?.player.body.x ?? 0;
    step(game, input, 30);
    expect(game.world?.player.body.x).toBe(frozenX);

    menuTap(game, input, 'confirm'); // RESUME
    expect(game.scene.name).toBe('playing');

    input.press('restart');
    step(game, input, 1);
    input.release('restart');
    expect(game.world?.player.body.x).toBe(game.world?.level.spawnX);
  });

  it('plays sounds for gameplay events', () => {
    const { game, audio } = createGame({ startLevelIndex: 0 });
    const input = new ScriptedInput(buildTape([{ action: 'jump', start: 2, duration: 10 }]));
    for (let frame = 0; frame < 60; frame += 1) {
      game.update(DT, input);
      input.endFrame();
    }
    expect(audio.played).toContain('jump');
    expect(audio.played).toContain('land');
  });
});

describe('Game — completing levels', () => {
  it('records the result, unlocks the next level and shows the summary', () => {
    const { game, storage } = createGame({ startLevelIndex: 0 });
    autoplayLevel(game);

    expect(game.scene.name).toBe('levelComplete');
    const summary = game.lastSummary;
    expect(summary).not.toBeNull();
    expect(summary?.timeSec).toBeGreaterThan(0);
    expect(summary?.newBestTime).toBe(true);
    expect(summary?.collectableTotal).toBeGreaterThan(0);

    const save = loadSave(storage);
    expect(save.completed).toEqual([LEVELS[0]?.id]);
    expect(save.unlockedIndex).toBe(1);
    expect(save.bestTimesMs[LEVELS[0]?.id ?? '']).toBeGreaterThan(0);
  });

  it('CONTINUE moves on to the next level', () => {
    const { game } = createGame({ startLevelIndex: 0 });
    autoplayLevel(game);
    const input = new FakeInput();
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('playing');
    expect(game.scene.levelIndex).toBe(1);
    expect(game.world?.level.id).toBe(LEVELS[1]?.id);
  });

  it('rolls the epilogue after the final level', () => {
    const lastIndex = LEVELS.length - 1;
    const { game } = createGame({ startLevelIndex: lastIndex });
    autoplayLevel(game, 60 * 180);
    expect(game.scene.name).toBe('levelComplete');
    const input = new FakeInput();
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('campaignComplete');
  });

  it('keeps the best time across replays', () => {
    const storage = memoryStorage();
    const first = createGame({ storage, startLevelIndex: 0 });
    autoplayLevel(first.game);
    const firstTime = loadSave(storage).bestTimesMs[LEVELS[0]?.id ?? ''] ?? 0;
    expect(firstTime).toBeGreaterThan(0);

    // A second identical run cannot beat it (same seed, same autopilot), so the record stands.
    const second = createGame({ storage, startLevelIndex: 0 });
    autoplayLevel(second.game);
    expect(loadSave(storage).bestTimesMs[LEVELS[0]?.id ?? '']).toBeLessThanOrEqual(firstTime);
  });
});

describe('Game — failing a level', () => {
  it('shows game over when every chassis is gone, then retries', () => {
    const { game, audio } = createGame({ startLevelIndex: 0 });
    const world = game.world;
    expect(world).not.toBeNull();
    const input = new FakeInput();

    // Burn through all three lives.
    for (let life = 0; life < 3; life += 1) {
      world?.damagePlayer(99, 0, 'damage');
      step(game, input, 120);
    }
    expect(game.scene.name).toBe('gameOver');
    expect(audio.played).toContain('death');

    menuTap(game, input, 'confirm'); // RETRY
    expect(game.scene.name).toBe('playing');
    expect(game.world?.livesLeft).toBe(3);
    expect(game.world?.player.body.x).toBe(game.world?.level.spawnX);
  });

  it('quitting from game over returns to the title with attract mode', () => {
    const { game } = createGame({ startLevelIndex: 0 });
    const input = new FakeInput();
    for (let life = 0; life < 3; life += 1) {
      game.world?.damagePlayer(99, 0, 'damage');
      step(game, input, 120);
    }
    menuTap(game, input, 'down');
    menuTap(game, input, 'confirm'); // QUIT TO TITLE
    expect(game.scene.name).toBe('title');
    expect(game.attractWorld).not.toBeNull();
  });
});

describe('Game — settings', () => {
  it('toggles mute and persists it', () => {
    const { game, storage, audio } = createGame();
    const input = new FakeInput();
    input.tap('mute');
    step(game, input, 1);
    expect(audio.isMuted()).toBe(true);
    expect(loadSave(storage).settings.muted).toBe(true);

    input.tap('mute');
    step(game, input, 1);
    expect(audio.isMuted()).toBe(false);
    expect(loadSave(storage).settings.muted).toBe(false);
  });

  it('changes volume, reduced motion and can wipe progress', () => {
    const storage = memoryStorage();
    const { game } = createGame({ storage });
    const input = new FakeInput();

    // Title → SETTINGS (4th item).
    for (let i = 0; i < 3; i += 1) menuTap(game, input, 'down');
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('settings');

    // VOLUME row: hold right to raise it.
    menuTap(game, input, 'down');
    const before = game.save.settings.volume;
    input.press('right');
    step(game, input, 10);
    input.release('right');
    expect(game.save.settings.volume).toBeGreaterThan(before);

    // REDUCED MOTION toggle.
    menuTap(game, input, 'down');
    menuTap(game, input, 'confirm');
    expect(game.save.settings.reducedMotion).toBe(true);
    expect(loadSave(storage).settings.reducedMotion).toBe(true);

    // RESET PROGRESS wipes records but keeps settings.
    menuTap(game, input, 'down');
    menuTap(game, input, 'confirm');
    expect(game.save.completed).toEqual([]);
    expect(game.save.unlockedIndex).toBe(0);
    expect(game.save.settings.reducedMotion).toBe(true);

    // BACK returns to the title.
    menuTap(game, input, 'down');
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('title');
  });

  it('reduced motion suppresses screen shake', () => {
    const { game } = createGame({ startLevelIndex: 0 });
    const world = game.world;
    expect(world).not.toBeNull();
    world?.setReducedMotion(true);
    world?.damagePlayer(1, 0, 'damage');
    step(game, new FakeInput(), 2);
    expect(world?.camera.shake).toBe(0);
  });
});

describe('Game — level select', () => {
  it('only lets you into unlocked levels', () => {
    const storage = memoryStorage();
    const first = createGame({ storage, startLevelIndex: 0 });
    autoplayLevel(first.game); // unlocks level 2

    const { game } = createGame({ storage });
    const input = new FakeInput();
    menuTap(game, input, 'down');
    menuTap(game, input, 'confirm'); // LEVEL SELECT
    expect(game.scene.name).toBe('levelSelect');

    // Move to the last level, which is still locked.
    for (let i = 0; i < LEVELS.length - 1; i += 1) menuTap(game, input, 'down');
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('levelSelect');

    // Level 2 is unlocked and starts.
    menuTap(game, input, 'up');
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('playing');
    expect(game.scene.levelIndex).toBe(1);
  });
});

describe('Game — snapshots', () => {
  it('produces a JSON-safe snapshot at every stage', () => {
    const { game } = createGame({ startLevelIndex: 0 });
    expect(() => JSON.stringify(game.snapshot())).not.toThrow();
    autoplayLevel(game);
    const snapshot = game.snapshot();
    expect(snapshot.scene).toBe('levelComplete');
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('works with a null audio implementation and no storage', () => {
    const audio: Audio = new NullAudio();
    const game = new Game({ audio });
    expect(() => step(game, new FakeInput(), 60)).not.toThrow();
    expect(game.scene.name).toBe('title');
  });
});

describe('Game — autoplay mode', () => {
  it('clears a level hands-free with autoplay enabled (the ?autoplay=1 path)', () => {
    // This exercises the real browser wiring: the caller passes only its own input and `Game` folds
    // the autopilot in. A regression here means the demo/attract input is not being stepped.
    const { game } = createGame({ startLevelIndex: 0, autoplay: true });
    const input = new FakeInput();
    for (let frame = 0; frame < 60 * 120; frame += 1) {
      game.update(DT, input);
      if (game.scene.name !== 'playing') break;
    }
    expect(game.scene.name).toBe('levelComplete');
    expect(game.lastSummary?.deaths ?? 99).toBeLessThanOrEqual(1);
  });

  it('carries autoplay into the next level', () => {
    const { game } = createGame({ startLevelIndex: 0, autoplay: true });
    const input = new FakeInput();
    for (let frame = 0; frame < 60 * 120 && game.scene.name === 'playing'; frame += 1) {
      game.update(DT, input);
    }
    expect(game.scene.name).toBe('levelComplete');
    menuTap(game, input, 'confirm');
    expect(game.scene.name).toBe('playing');
    expect(game.scene.levelIndex).toBe(1);
    const startX = game.world?.player.body.x ?? 0;
    step(game, input, 120);
    expect(game.world?.player.body.x ?? 0).toBeGreaterThan(startX + 30);
  });
});

describe('every campaign level is completable', () => {
  it.each(LEVELS.map((level, index) => [level.id, index] as const))(
    '%s can be finished by the autopilot',
    (_id, index) => {
      const { game } = createGame({ startLevelIndex: index });
      autoplayLevel(game, 60 * 240);
      expect(game.scene.name).toBe('levelComplete');
      const summary = game.lastSummary;
      expect(summary).not.toBeNull();
      // A fair level does not cost the autopilot more than a handful of chassis.
      expect(summary?.deaths ?? 99).toBeLessThanOrEqual(4);
      // And it should be finishable within twice par.
      expect(summary?.timeSec ?? 999).toBeLessThan((summary?.parTimeSec ?? 0) * 2);
    },
  );
});
