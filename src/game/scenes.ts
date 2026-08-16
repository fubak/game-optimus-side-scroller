/**
 * Scene state machine.
 *
 * A pure reducer: `(state, event) → state`. No timers, no DOM, no side effects — which means the
 * whole flow of the game (title → play → die → retry → next level → credits) is unit-testable, and
 * illegal transitions are simply ignored instead of corrupting the game.
 */

export type SceneName =
  | 'title'
  | 'levelSelect'
  | 'howToPlay'
  | 'settings'
  | 'playing'
  | 'paused'
  | 'levelComplete'
  | 'gameOver'
  | 'campaignComplete';

export interface SceneState {
  readonly name: SceneName;
  /** Campaign index of the level being played or selected. */
  readonly levelIndex: number;
  /** Menu cursor position within the current scene. */
  readonly cursor: number;
  /** Scene to return to when leaving a sub-menu. */
  readonly returnTo: SceneName;
  /** Cursor position to restore when leaving a sub-menu, so the caller's selection is remembered. */
  readonly returnCursor: number;
}

export type SceneEvent =
  | { readonly type: 'confirm' }
  | { readonly type: 'back' }
  | { readonly type: 'moveCursor'; readonly delta: number }
  | { readonly type: 'startLevel'; readonly levelIndex: number }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'restartLevel' }
  | { readonly type: 'levelCompleted' }
  | { readonly type: 'levelFailed' }
  | { readonly type: 'advance'; readonly hasNextLevel: boolean }
  | { readonly type: 'quitToTitle' }
  | { readonly type: 'openLevelSelect' }
  | { readonly type: 'openHowToPlay' }
  | { readonly type: 'openSettings' };

/** Menu entries per scene, in cursor order. Used for wrapping and by the renderer. */
export const MENU_ITEMS: Readonly<Record<SceneName, readonly string[]>> = {
  title: ['START', 'LEVEL SELECT', 'HOW TO PLAY', 'SETTINGS'],
  levelSelect: [],
  howToPlay: ['BACK'],
  settings: ['SOUND', 'VOLUME', 'REDUCED MOTION', 'RESET PROGRESS', 'BACK'],
  playing: [],
  paused: ['RESUME', 'RESTART', 'SETTINGS', 'QUIT TO TITLE'],
  levelComplete: ['CONTINUE', 'RETRY', 'QUIT TO TITLE'],
  gameOver: ['RETRY', 'QUIT TO TITLE'],
  campaignComplete: ['BACK TO TITLE'],
};

export function createSceneState(): SceneState {
  return { name: 'title', levelIndex: 0, cursor: 0, returnTo: 'title', returnCursor: 0 };
}

function menuLength(name: SceneName, levelCount: number): number {
  if (name === 'levelSelect') return Math.max(1, levelCount);
  return Math.max(1, MENU_ITEMS[name].length);
}

function withCursor(state: SceneState, cursor: number): SceneState {
  return { ...state, cursor };
}

export interface SceneContext {
  /** Number of campaign levels, for level-select bounds. */
  readonly levelCount: number;
  /** Highest unlocked campaign index. */
  readonly unlockedIndex: number;
}

/**
 * Advance the scene machine.
 *
 * Unknown/irrelevant events return the same state object, so callers can feed everything in without
 * guarding, and `===` identity tells you whether anything changed.
 */
export function reduceScene(state: SceneState, event: SceneEvent, context: SceneContext): SceneState {
  switch (event.type) {
    case 'moveCursor': {
      const length = menuLength(state.name, context.levelCount);
      const next = (((state.cursor + event.delta) % length) + length) % length;
      return withCursor(state, next);
    }
    case 'startLevel':
      return {
        name: 'playing',
        levelIndex: Math.max(0, Math.min(context.levelCount - 1, event.levelIndex)),
        cursor: 0,
        returnTo: 'title',
        returnCursor: 0,
      };
    case 'pause':
      return state.name === 'playing' ? { ...state, name: 'paused', cursor: 0 } : state;
    case 'resume':
      return state.name === 'paused' ? { ...state, name: 'playing', cursor: 0 } : state;
    case 'restartLevel':
      return state.name === 'paused' ||
        state.name === 'gameOver' ||
        state.name === 'levelComplete' ||
        state.name === 'playing'
        ? { ...state, name: 'playing', cursor: 0 }
        : state;
    case 'levelCompleted':
      return state.name === 'playing' ? { ...state, name: 'levelComplete', cursor: 0 } : state;
    case 'levelFailed':
      return state.name === 'playing' ? { ...state, name: 'gameOver', cursor: 0 } : state;
    case 'advance': {
      if (state.name !== 'levelComplete') return state;
      if (!event.hasNextLevel) return { ...state, name: 'campaignComplete', cursor: 0 };
      return {
        ...state,
        name: 'playing',
        levelIndex: Math.min(context.levelCount - 1, state.levelIndex + 1),
        cursor: 0,
      };
    }
    case 'quitToTitle':
      return { name: 'title', levelIndex: state.levelIndex, cursor: 0, returnTo: 'title', returnCursor: 0 };
    case 'openLevelSelect':
      return {
        ...state,
        name: 'levelSelect',
        cursor: Math.min(state.levelIndex, context.levelCount - 1),
        returnTo: state.name,
      };
    case 'openHowToPlay':
      return { ...state, name: 'howToPlay', cursor: 0, returnTo: state.name };
    case 'openSettings':
      return { ...state, name: 'settings', cursor: 0, returnTo: state.name };
    case 'back':
      return applyBack(state);
    case 'confirm':
      return applyConfirm(state, context);
    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled scene event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Open a sub-menu, remembering where the cursor was so `back` can put it back. */
function openSubMenu(state: SceneState, name: SceneName, cursor: number): SceneState {
  return { ...state, name, cursor, returnTo: state.name, returnCursor: state.cursor };
}

/** Leave a sub-menu, restoring the caller's cursor. */
function closeSubMenu(state: SceneState): SceneState {
  return { ...state, name: state.returnTo, cursor: state.returnCursor, returnTo: 'title', returnCursor: 0 };
}

function applyBack(state: SceneState): SceneState {
  switch (state.name) {
    case 'howToPlay':
    case 'settings':
    case 'levelSelect':
      return closeSubMenu(state);
    case 'paused':
      return { ...state, name: 'playing', cursor: 0 };
    case 'playing':
      return { ...state, name: 'paused', cursor: 0 };
    case 'title':
    case 'levelComplete':
    case 'gameOver':
    case 'campaignComplete':
      return state;
    default: {
      const exhaustive: never = state.name;
      throw new Error(`Unhandled scene: ${String(exhaustive)}`);
    }
  }
}

function applyConfirm(state: SceneState, context: SceneContext): SceneState {
  switch (state.name) {
    case 'title': {
      const item = MENU_ITEMS.title[state.cursor];
      if (item === undefined) return state;
      switch (item) {
        case 'START':
          return { name: 'playing', levelIndex: 0, cursor: 0, returnTo: 'title', returnCursor: 0 };
        case 'LEVEL SELECT':
          return openSubMenu(state, 'levelSelect', 0);
        case 'HOW TO PLAY':
          return openSubMenu(state, 'howToPlay', 0);
        case 'SETTINGS':
          return openSubMenu(state, 'settings', 0);
        default:
          return state;
      }
    }
    case 'levelSelect': {
      const index = state.cursor;
      if (index > context.unlockedIndex) return state;
      return { name: 'playing', levelIndex: index, cursor: 0, returnTo: 'title', returnCursor: 0 };
    }
    case 'howToPlay':
      return closeSubMenu(state);
    case 'settings': {
      // Toggles are applied by the caller (they mutate settings); only BACK changes the scene.
      const item = MENU_ITEMS.settings[state.cursor];
      if (item === 'BACK') return closeSubMenu(state);
      return state;
    }
    case 'paused': {
      const item = MENU_ITEMS.paused[state.cursor];
      if (item === undefined) return state;
      switch (item) {
        case 'RESUME':
          return { ...state, name: 'playing', cursor: 0 };
        case 'RESTART':
          return { ...state, name: 'playing', cursor: 0 };
        case 'SETTINGS':
          return openSubMenu(state, 'settings', 0);
        case 'QUIT TO TITLE':
          return {
            name: 'title',
            levelIndex: state.levelIndex,
            cursor: 0,
            returnTo: 'title',
            returnCursor: 0,
          };
        default:
          return state;
      }
    }
    case 'levelComplete': {
      const item = MENU_ITEMS.levelComplete[state.cursor];
      if (item === undefined) return state;
      switch (item) {
        case 'CONTINUE':
          return state.levelIndex + 1 >= context.levelCount
            ? { ...state, name: 'campaignComplete', cursor: 0 }
            : { ...state, name: 'playing', levelIndex: state.levelIndex + 1, cursor: 0 };
        case 'RETRY':
          return { ...state, name: 'playing', cursor: 0 };
        case 'QUIT TO TITLE':
          return {
            name: 'title',
            levelIndex: state.levelIndex,
            cursor: 0,
            returnTo: 'title',
            returnCursor: 0,
          };
        default:
          return state;
      }
    }
    case 'gameOver': {
      const item = MENU_ITEMS.gameOver[state.cursor];
      if (item === 'RETRY') return { ...state, name: 'playing', cursor: 0 };
      return { name: 'title', levelIndex: state.levelIndex, cursor: 0, returnTo: 'title', returnCursor: 0 };
    }
    case 'campaignComplete':
      return { name: 'title', levelIndex: 0, cursor: 0, returnTo: 'title', returnCursor: 0 };
    case 'playing':
      return state;
    default: {
      const exhaustive: never = state.name;
      throw new Error(`Unhandled scene: ${String(exhaustive)}`);
    }
  }
}

/** Does this scene run the simulation? */
export function isSimulating(name: SceneName): boolean {
  return name === 'playing';
}

/** Should the world be drawn behind this scene (as a backdrop)? */
export function showsWorld(name: SceneName): boolean {
  switch (name) {
    case 'playing':
    case 'paused':
    case 'levelComplete':
    case 'gameOver':
      return true;
    case 'title':
    case 'levelSelect':
    case 'howToPlay':
    case 'settings':
    case 'campaignComplete':
      return false;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unhandled scene: ${String(exhaustive)}`);
    }
  }
}

/** Currently selected menu item label, or null when the scene has no menu. */
export function currentMenuItem(state: SceneState): string | null {
  return MENU_ITEMS[state.name][state.cursor] ?? null;
}
