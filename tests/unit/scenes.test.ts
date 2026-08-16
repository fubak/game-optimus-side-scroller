import { describe, expect, it } from 'vitest';
import {
  MENU_ITEMS,
  createSceneState,
  currentMenuItem,
  isSimulating,
  reduceScene,
  showsWorld,
} from '../../src/game/scenes';
import type { SceneEvent, SceneName, SceneState } from '../../src/game/scenes';

const CONTEXT = { levelCount: 3, unlockedIndex: 0 };

function reduce(state: SceneState, ...events: SceneEvent[]): SceneState {
  return events.reduce((current, event) => reduceScene(current, event, CONTEXT), state);
}

function at(name: SceneName, overrides: Partial<SceneState> = {}): SceneState {
  return { name, levelIndex: 0, cursor: 0, returnTo: 'title', ...overrides };
}

describe('scene machine', () => {
  it('starts on the title screen', () => {
    const state = createSceneState();
    expect(state.name).toBe('title');
    expect(state.cursor).toBe(0);
    expect(currentMenuItem(state)).toBe('START');
  });

  it('wraps the menu cursor in both directions', () => {
    let state = createSceneState();
    const length = MENU_ITEMS.title.length;
    state = reduce(state, { type: 'moveCursor', delta: -1 });
    expect(state.cursor).toBe(length - 1);
    state = reduce(state, { type: 'moveCursor', delta: 1 });
    expect(state.cursor).toBe(0);
    state = reduce(state, { type: 'moveCursor', delta: length + 2 });
    expect(state.cursor).toBe(2);
  });

  it('walks the title menu into each destination', () => {
    const start = reduce(createSceneState(), { type: 'confirm' });
    expect(start.name).toBe('playing');
    expect(start.levelIndex).toBe(0);

    const select = reduce(createSceneState(), { type: 'moveCursor', delta: 1 }, { type: 'confirm' });
    expect(select.name).toBe('levelSelect');

    const help = reduce(createSceneState(), { type: 'moveCursor', delta: 2 }, { type: 'confirm' });
    expect(help.name).toBe('howToPlay');

    const settings = reduce(createSceneState(), { type: 'moveCursor', delta: 3 }, { type: 'confirm' });
    expect(settings.name).toBe('settings');
  });

  it('returns from sub-menus to wherever they were opened from', () => {
    const fromTitle = reduce(at('title'), { type: 'openSettings' }, { type: 'back' });
    expect(fromTitle.name).toBe('title');

    const fromPause = reduce(at('paused'), { type: 'openSettings' }, { type: 'back' });
    expect(fromPause.name).toBe('paused');
  });

  it('pauses and resumes only from the right scenes', () => {
    const paused = reduce(at('playing'), { type: 'pause' });
    expect(paused.name).toBe('paused');
    expect(reduce(paused, { type: 'resume' }).name).toBe('playing');
    // Pausing the title screen is a no-op.
    const title = at('title');
    expect(reduceScene(title, { type: 'pause' }, CONTEXT)).toBe(title);
    // As is resuming while not paused.
    expect(reduceScene(title, { type: 'resume' }, CONTEXT)).toBe(title);
  });

  it('esc toggles pause during play and backs out of the pause menu', () => {
    const paused = reduce(at('playing'), { type: 'back' });
    expect(paused.name).toBe('paused');
    expect(reduce(paused, { type: 'back' }).name).toBe('playing');
  });

  it('runs the pause menu options', () => {
    const paused = at('paused', { levelIndex: 1 });
    expect(reduce(paused, { type: 'confirm' }).name).toBe('playing'); // RESUME
    expect(reduce(paused, { type: 'moveCursor', delta: 1 }, { type: 'confirm' }).name).toBe('playing'); // RESTART
    const settings = reduce(paused, { type: 'moveCursor', delta: 2 }, { type: 'confirm' });
    expect(settings.name).toBe('settings');
    expect(settings.returnTo).toBe('paused');
    const quit = reduce(paused, { type: 'moveCursor', delta: 3 }, { type: 'confirm' });
    expect(quit.name).toBe('title');
  });

  it('completes and fails levels only while playing', () => {
    const complete = reduce(at('playing'), { type: 'levelCompleted' });
    expect(complete.name).toBe('levelComplete');
    const failed = reduce(at('playing'), { type: 'levelFailed' });
    expect(failed.name).toBe('gameOver');
    const title = at('title');
    expect(reduceScene(title, { type: 'levelCompleted' }, CONTEXT)).toBe(title);
    expect(reduceScene(title, { type: 'levelFailed' }, CONTEXT)).toBe(title);
  });

  it('advances to the next level, or to the epilogue after the last one', () => {
    const afterFirst = reduce(at('levelComplete', { levelIndex: 0 }), {
      type: 'advance',
      hasNextLevel: true,
    });
    expect(afterFirst.name).toBe('playing');
    expect(afterFirst.levelIndex).toBe(1);

    const afterLast = reduce(at('levelComplete', { levelIndex: 2 }), {
      type: 'advance',
      hasNextLevel: false,
    });
    expect(afterLast.name).toBe('campaignComplete');
  });

  it('CONTINUE on the last level rolls the credits', () => {
    const state = at('levelComplete', { levelIndex: CONTEXT.levelCount - 1 });
    expect(reduce(state, { type: 'confirm' }).name).toBe('campaignComplete');
  });

  it('level complete offers retry and quit', () => {
    const state = at('levelComplete', { levelIndex: 1 });
    const retry = reduce(state, { type: 'moveCursor', delta: 1 }, { type: 'confirm' });
    expect(retry.name).toBe('playing');
    expect(retry.levelIndex).toBe(1);
    const quit = reduce(state, { type: 'moveCursor', delta: 2 }, { type: 'confirm' });
    expect(quit.name).toBe('title');
  });

  it('game over retries the same level or quits', () => {
    const state = at('gameOver', { levelIndex: 2 });
    const retry = reduce(state, { type: 'confirm' });
    expect(retry).toMatchObject({ name: 'playing', levelIndex: 2 });
    const quit = reduce(state, { type: 'moveCursor', delta: 1 }, { type: 'confirm' });
    expect(quit.name).toBe('title');
  });

  it('level select refuses locked levels and accepts unlocked ones', () => {
    const state = at('levelSelect', { cursor: 2 });
    // Nothing unlocked past index 0 yet.
    expect(reduceScene(state, { type: 'confirm' }, CONTEXT)).toBe(state);
    const withUnlocks = reduceScene(state, { type: 'confirm' }, { levelCount: 3, unlockedIndex: 2 });
    expect(withUnlocks).toMatchObject({ name: 'playing', levelIndex: 2 });
  });

  it('level select cursor is bounded by the level count', () => {
    let state = reduce(at('title'), { type: 'openLevelSelect' });
    for (let i = 0; i < 10; i += 1) state = reduce(state, { type: 'moveCursor', delta: 1 });
    expect(state.cursor).toBeLessThan(CONTEXT.levelCount);
  });

  it('startLevel clamps to the available levels', () => {
    expect(reduce(at('title'), { type: 'startLevel', levelIndex: 99 }).levelIndex).toBe(2);
    expect(reduce(at('title'), { type: 'startLevel', levelIndex: -5 }).levelIndex).toBe(0);
  });

  it('the epilogue returns to the title', () => {
    expect(reduce(at('campaignComplete'), { type: 'confirm' }).name).toBe('title');
  });

  it('reports which scenes simulate and which show the world', () => {
    expect(isSimulating('playing')).toBe(true);
    expect(isSimulating('paused')).toBe(false);
    expect(showsWorld('paused')).toBe(true);
    expect(showsWorld('levelComplete')).toBe(true);
    expect(showsWorld('title')).toBe(false);
    expect(showsWorld('settings')).toBe(false);
  });

  it('ignores events that do not apply, returning the identical state object', () => {
    const state = at('gameOver');
    expect(reduceScene(state, { type: 'resume' }, CONTEXT)).toBe(state);
    expect(reduceScene(state, { type: 'advance', hasNextLevel: true }, CONTEXT)).toBe(state);
    expect(reduceScene(state, { type: 'back' }, CONTEXT)).toBe(state);
  });

  it('throws on an unknown event so new events cannot be silently dropped', () => {
    expect(() => reduceScene(at('title'), { type: 'nope' } as unknown as SceneEvent, CONTEXT)).toThrow(
      /Unhandled scene event/,
    );
  });
});
