import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SAVE_KEY,
  SAVE_VERSION,
  clearSave,
  createDefaultSave,
  isLevelUnlocked,
  loadSave,
  memoryStorage,
  recordLevelResult,
  saveGame,
} from '../../src/core/storage';
import type { StorageLike } from '../../src/core/storage';

describe('save file', () => {
  it('starts empty with default settings', () => {
    const save = createDefaultSave();
    expect(save.version).toBe(SAVE_VERSION);
    expect(save.completed).toEqual([]);
    expect(save.unlockedIndex).toBe(0);
    expect(save.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const save = createDefaultSave();
    save.bestTimesMs['level-1'] = 12_345;
    save.completed = ['level-1'];
    save.unlockedIndex = 1;
    save.settings.muted = true;
    saveGame(storage, save);
    const loaded = loadSave(storage);
    expect(loaded.bestTimesMs['level-1']).toBe(12_345);
    expect(loaded.completed).toEqual(['level-1']);
    expect(loaded.unlockedIndex).toBe(1);
    expect(loaded.settings.muted).toBe(true);
  });

  it('recovers from corrupt, empty and hostile values', () => {
    for (const value of ['', 'not json', '[]', 'null', '{"bestTimesMs":"nope"}', '{"settings":42}']) {
      const storage = memoryStorage({ [SAVE_KEY]: value });
      const loaded = loadSave(storage);
      expect(loaded.version).toBe(SAVE_VERSION);
      expect(loaded.bestTimesMs).toEqual({});
      expect(loaded.settings.volume).toBe(DEFAULT_SETTINGS.volume);
    }
  });

  it('drops nonsense entries but keeps the good ones', () => {
    const storage = memoryStorage({
      [SAVE_KEY]: JSON.stringify({
        bestTimesMs: { 'level-1': 1000, 'level-2': 'fast', 'level-3': -5 },
        bestScores: { 'level-1': 500 },
        completed: ['level-1', 7, null],
        settings: { muted: 'yes', volume: 5, reducedMotion: true, bindings: { KeyZ: ['jump'], KeyX: 3 } },
      }),
    });
    const loaded = loadSave(storage);
    expect(loaded.bestTimesMs).toEqual({ 'level-1': 1000 });
    expect(loaded.bestScores).toEqual({ 'level-1': 500 });
    expect(loaded.completed).toEqual(['level-1']);
    expect(loaded.settings.muted).toBe(DEFAULT_SETTINGS.muted);
    expect(loaded.settings.volume).toBe(1);
    expect(loaded.settings.reducedMotion).toBe(true);
    expect(loaded.settings.bindings).toEqual({ KeyZ: ['jump'] });
  });

  it('migrates a v1 save (unlockedLevel id → unlockedIndex)', () => {
    const storage = memoryStorage({
      [SAVE_KEY]: JSON.stringify({
        version: 1,
        bestTimesMs: { 'level-1': 20_000 },
        unlockedLevel: 'level-2',
        completed: ['level-1'],
      }),
    });
    const loaded = loadSave(storage);
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.unlockedIndex).toBe(1);
    expect(loaded.bestTimesMs['level-1']).toBe(20_000);
  });

  it('never lets completion outrun the unlock index', () => {
    const storage = memoryStorage({
      [SAVE_KEY]: JSON.stringify({ completed: ['a', 'b', 'c'], unlockedIndex: 0 }),
    });
    expect(loadSave(storage).unlockedIndex).toBe(3);
  });

  it('survives storage that throws', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSave(hostile)).toEqual(createDefaultSave());
    expect(() => saveGame(hostile, createDefaultSave())).not.toThrow();
    expect(() => clearSave(hostile)).not.toThrow();
  });

  it('clears the save', () => {
    const storage = memoryStorage();
    saveGame(storage, createDefaultSave());
    clearSave(storage);
    expect(storage.getItem(SAVE_KEY)).toBeNull();
  });
});

describe('recordLevelResult', () => {
  const base = createDefaultSave();

  it('records a first completion, unlocking the next level', () => {
    const outcome = recordLevelResult(
      base,
      { levelId: 'level-1', levelIndex: 0, timeMs: 30_000, score: 500 },
      3,
    );
    expect(outcome.newBestTime).toBe(true);
    expect(outcome.newBestScore).toBe(true);
    expect(outcome.unlockedNext).toBe(true);
    expect(outcome.save.unlockedIndex).toBe(1);
    expect(outcome.save.completed).toEqual(['level-1']);
    expect(outcome.save.bestTimesMs['level-1']).toBe(30_000);
    // The input save is untouched (the function is pure).
    expect(base.completed).toEqual([]);
  });

  it('keeps the faster time and the higher score', () => {
    const first = recordLevelResult(
      base,
      { levelId: 'l1', levelIndex: 0, timeMs: 30_000, score: 500 },
      3,
    ).save;
    const slower = recordLevelResult(first, { levelId: 'l1', levelIndex: 0, timeMs: 45_000, score: 900 }, 3);
    expect(slower.newBestTime).toBe(false);
    expect(slower.save.bestTimesMs.l1).toBe(30_000);
    expect(slower.newBestScore).toBe(true);
    expect(slower.save.bestScores.l1).toBe(900);

    const faster = recordLevelResult(
      slower.save,
      { levelId: 'l1', levelIndex: 0, timeMs: 20_000, score: 100 },
      3,
    );
    expect(faster.newBestTime).toBe(true);
    expect(faster.save.bestTimesMs.l1).toBe(20_000);
    expect(faster.newBestScore).toBe(false);
    expect(faster.save.bestScores.l1).toBe(900);
  });

  it('does not duplicate completions and stops unlocking past the last level', () => {
    let save = recordLevelResult(base, { levelId: 'l1', levelIndex: 0, timeMs: 1, score: 1 }, 2).save;
    save = recordLevelResult(save, { levelId: 'l1', levelIndex: 0, timeMs: 2, score: 2 }, 2).save;
    expect(save.completed).toEqual(['l1']);

    const last = recordLevelResult(save, { levelId: 'l2', levelIndex: 1, timeMs: 1, score: 1 }, 2);
    expect(last.save.unlockedIndex).toBe(1);
    expect(last.unlockedNext).toBe(false);
  });

  it('reports unlock state', () => {
    const save = { ...createDefaultSave(), unlockedIndex: 1 };
    expect(isLevelUnlocked(save, 0)).toBe(true);
    expect(isLevelUnlocked(save, 1)).toBe(true);
    expect(isLevelUnlocked(save, 2)).toBe(false);
  });
});
