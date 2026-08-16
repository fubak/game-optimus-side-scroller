/**
 * Persistent save data.
 *
 * A single versioned JSON blob in `localStorage`. Every read is defensive: a corrupt, truncated or
 * hand-edited value must never break the game, it just falls back to a fresh save. Migrations run on
 * load so older saves keep working.
 */

export const SAVE_KEY = 'optimus.save.v1';
export const SAVE_VERSION = 3;

export interface Settings {
  muted: boolean;
  /** Master volume 0..1. */
  volume: number;
  /** Disables screen shake, flashes and heavy particle effects. */
  reducedMotion: boolean;
  /** Brightens terrain and the player, darkens the backdrop, saturates hazards. */
  highContrast: boolean;
  /** Alternative keyboard layout (Z/X style) for players who cannot reach shift/space comfortably. */
  altBindings: boolean;
  /** Key code → action names, for remapping. */
  bindings: Record<string, string[]>;
}

export interface SaveData {
  version: number;
  /** Best (lowest) completion time per level id, in ms. */
  bestTimesMs: Record<string, number>;
  /** Best score per level id. */
  bestScores: Record<string, number>;
  /** Levels the player has finished. */
  completed: string[];
  /** Highest campaign index unlocked (0 = only the first level). */
  unlockedIndex: number;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  muted: false,
  volume: 0.7,
  reducedMotion: false,
  highContrast: false,
  altBindings: false,
  bindings: {},
};

export function createDefaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    bestTimesMs: {},
    bestScores: {},
    completed: [],
    unlockedIndex: 0,
    settings: { ...DEFAULT_SETTINGS, bindings: {} },
  };
}

/** Minimal storage surface, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) result[key] = entry;
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS, bindings: {} };
  const bindings: Record<string, string[]> = {};
  if (isRecord(value.bindings)) {
    for (const [key, actions] of Object.entries(value.bindings)) {
      const list = stringArray(actions);
      if (list.length > 0) bindings[key] = list;
    }
  }
  return {
    muted: typeof value.muted === 'boolean' ? value.muted : DEFAULT_SETTINGS.muted,
    volume:
      typeof value.volume === 'number' && Number.isFinite(value.volume)
        ? Math.min(1, Math.max(0, value.volume))
        : DEFAULT_SETTINGS.volume,
    reducedMotion:
      typeof value.reducedMotion === 'boolean' ? value.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    highContrast:
      typeof value.highContrast === 'boolean' ? value.highContrast : DEFAULT_SETTINGS.highContrast,
    altBindings: typeof value.altBindings === 'boolean' ? value.altBindings : DEFAULT_SETTINGS.altBindings,
    bindings,
  };
}

/**
 * Migrate a parsed save to the current version.
 *
 * v1 → v2: `bestScores` and `completed` were added, and `unlockedLevel` (a level id) became
 * `unlockedIndex` (a campaign index).
 * v2 → v3: the accessibility settings (`highContrast`, `altBindings`) were added; missing values
 * simply fall back to their defaults, which `parseSettings` already handles.
 */
function migrate(raw: Record<string, unknown>): SaveData {
  const save = createDefaultSave();
  save.bestTimesMs = numberRecord(raw.bestTimesMs);
  save.bestScores = numberRecord(raw.bestScores);
  save.completed = stringArray(raw.completed);
  if (typeof raw.unlockedIndex === 'number' && Number.isFinite(raw.unlockedIndex)) {
    save.unlockedIndex = Math.max(0, Math.floor(raw.unlockedIndex));
  } else if (typeof raw.unlockedLevel === 'string') {
    // v1 stored a level id; the id is no longer authoritative, so unlock by completion count.
    save.unlockedIndex = Math.max(0, save.completed.length);
  }
  save.settings = parseSettings(raw.settings);
  // Completing a level implies it is unlocked.
  save.unlockedIndex = Math.max(save.unlockedIndex, save.completed.length);
  return save;
}

export function loadSave(storage: StorageLike): SaveData {
  try {
    // Private browsing modes can throw on access, and the stored value may be anything at all;
    // every failure path lands on a fresh save rather than breaking the game.
    const raw = storage.getItem(SAVE_KEY);
    if (raw === null || raw === '') return createDefaultSave();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return createDefaultSave();
    return migrate(parsed);
  } catch {
    return createDefaultSave();
  }
}

export function saveGame(storage: StorageLike, data: SaveData): void {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify({ ...data, version: SAVE_VERSION }));
  } catch {
    // Storage full or blocked: losing progress is bad, crashing mid-game is worse.
  }
}

export function clearSave(storage: StorageLike): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    // Nothing sensible to do.
  }
}

export interface LevelResult {
  readonly levelId: string;
  readonly levelIndex: number;
  readonly timeMs: number;
  readonly score: number;
}

export interface RecordOutcome {
  readonly save: SaveData;
  readonly newBestTime: boolean;
  readonly newBestScore: boolean;
  readonly unlockedNext: boolean;
}

/**
 * Fold a level result into a save.
 *
 * Pure: it returns a new save rather than mutating, so the caller decides when to persist and tests
 * can assert on the result.
 */
export function recordLevelResult(save: SaveData, result: LevelResult, levelCount: number): RecordOutcome {
  const previousTime = save.bestTimesMs[result.levelId];
  const previousScore = save.bestScores[result.levelId];
  const newBestTime = previousTime === undefined || result.timeMs < previousTime;
  const newBestScore = previousScore === undefined || result.score > previousScore;

  const completed = save.completed.includes(result.levelId)
    ? save.completed
    : [...save.completed, result.levelId];
  const nextIndex = Math.min(levelCount - 1, result.levelIndex + 1);
  const unlockedNext = nextIndex > save.unlockedIndex;

  return {
    save: {
      ...save,
      version: SAVE_VERSION,
      bestTimesMs: newBestTime ? { ...save.bestTimesMs, [result.levelId]: result.timeMs } : save.bestTimesMs,
      bestScores: newBestScore ? { ...save.bestScores, [result.levelId]: result.score } : save.bestScores,
      completed,
      unlockedIndex: Math.max(save.unlockedIndex, nextIndex),
    },
    newBestTime,
    newBestScore,
    unlockedNext,
  };
}

export function isLevelUnlocked(save: SaveData, levelIndex: number): boolean {
  return levelIndex <= save.unlockedIndex;
}
