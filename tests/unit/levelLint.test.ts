import { describe, expect, it } from 'vitest';
import {
  MAX_GAP_TILES,
  MAX_JUMP_TILES,
  MAX_STEP_TILES,
  auditLevel,
  findRaggedRows,
} from '../../src/game/levelAudit';
import { ALL_LEVELS } from '../../src/game/levels/index';
import { parseLevel } from '../../src/game/levelParser';

/**
 * Layout lint for every shipped level.
 *
 * These are the checks that catch hand-editing mistakes: a row one character short shifts the whole
 * level, and a pit one tile too wide makes a level impossible. The limits come from the movement
 * tuning, so re-tuning the jump automatically re-validates the levels.
 */
describe('level layout limits', () => {
  it('derives sane movement limits from the tuning constants', () => {
    expect(MAX_JUMP_TILES).toBeGreaterThanOrEqual(3);
    expect(MAX_GAP_TILES).toBeGreaterThanOrEqual(4);
    expect(MAX_STEP_TILES).toBeGreaterThanOrEqual(2);
  });
});

describe.each(ALL_LEVELS.map((def) => [def.id, def] as const))('level %s', (_id, def) => {
  it('has rows of identical length', () => {
    expect(findRaggedRows(def.rows)).toEqual([]);
  });

  it('passes the layout audit', () => {
    const audit = auditLevel(parseLevel(def));
    expect(audit.problems).toEqual([]);
  });

  it('keeps gaps and steps inside the movement limits', () => {
    const audit = auditLevel(parseLevel(def));
    expect(audit.widestGap).toBeLessThanOrEqual(MAX_GAP_TILES);
    expect(audit.tallestStep).toBeLessThanOrEqual(MAX_STEP_TILES);
  });
});
