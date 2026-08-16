import { describe, expect, it } from 'vitest';
import { drawText, glyphRows, measureText, textHeight } from '../../src/render/text';
import { formatScore, formatTime } from '../../src/render/hud';

/**
 * Font data checks.
 *
 * A bitmap font is a wall of hex; a single wrong nibble makes a glyph unreadable and nothing else
 * fails. These tests pin down the shape of a few glyphs, verify every character the UI actually
 * draws is present, and confirm metrics used for centring.
 */
describe('bitmap font', () => {
  it('renders A as expected', () => {
    expect(glyphRows('A')).toEqual(['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']);
  });

  it('renders 0 with a slash through it', () => {
    expect(glyphRows('0')).toEqual(['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.']);
  });

  it('is 5×7 with a blank space glyph', () => {
    expect(glyphRows(' ').every((row) => row === '.....')).toBe(true);
    expect(glyphRows('W')).toHaveLength(7);
    expect(glyphRows('W')[0]).toHaveLength(5);
  });

  it('falls back to ? for unknown characters', () => {
    expect(glyphRows('€')).toEqual(glyphRows('?'));
  });

  it('accepts lowercase by mapping to uppercase', () => {
    expect(glyphRows('a')).toEqual(glyphRows('A'));
  });

  it('includes every character used by the UI', () => {
    // '?' is the fallback, so it is checked separately from the "not the fallback" comparison.
    const used = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!-_+=*/%\'"()[]<>#×←→↑↓♥·—…';
    for (const character of used) {
      expect(glyphRows(character), `missing glyph for '${character}'`).not.toEqual(glyphRows('€'));
    }
    expect(glyphRows('?')).toEqual(['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..']);
  });

  it('measures text width and height', () => {
    expect(measureText('')).toBe(0);
    expect(measureText('A')).toBe(5);
    expect(measureText('AB')).toBe(11);
    expect(measureText('AB', 2)).toBe(22);
    expect(measureText('AB', 1, 2)).toBe(12);
    expect(textHeight()).toBe(7);
    expect(textHeight(3)).toBe(21);
  });
});

/** Minimal 2D context stand-in that records the rectangles it is asked to fill. */
function fakeContext(): { ctx: CanvasRenderingContext2D; rects: number[][]; colors: string[] } {
  const rects: number[][] = [];
  const colors: string[] = [];
  const ctx = {
    fillStyle: '',
    fillRect(x: number, y: number, width: number, height: number) {
      rects.push([x, y, width, height]);
      colors.push(String((ctx as unknown as { fillStyle: string }).fillStyle));
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, colors };
}

describe('drawText', () => {
  it('draws one rect per lit pixel at the requested scale', () => {
    const { ctx, rects } = fakeContext();
    drawText(ctx, 'I', 10, 20, { color: '#fff' });
    // 'I' has 3 + 1 + 1 + 1 + 1 + 1 + 3 = 11 lit pixels.
    expect(rects).toHaveLength(11);
    expect(rects[0]).toEqual([11, 20, 1, 1]);

    const scaled = fakeContext();
    drawText(scaled.ctx, 'I', 0, 0, { scale: 3 });
    expect(scaled.rects).toHaveLength(11);
    expect(scaled.rects[0]).toEqual([3, 0, 3, 3]);
  });

  it('aligns left, centre and right', () => {
    const left = fakeContext();
    drawText(left.ctx, 'AB', 100, 0);
    const center = fakeContext();
    drawText(center.ctx, 'AB', 100, 0, { align: 'center' });
    const right = fakeContext();
    drawText(right.ctx, 'AB', 100, 0, { align: 'right' });
    const firstX = (fake: ReturnType<typeof fakeContext>): number => fake.rects[0]?.[0] ?? 0;
    expect(firstX(left)).toBe(101);
    // Centring rounds to whole pixels so glyphs stay on the pixel grid.
    expect(firstX(center)).toBe(Math.round(100 - measureText('AB') / 2) + 1);
    expect(firstX(right)).toBe(101 - measureText('AB'));
  });

  it('draws a shadow pass before the text', () => {
    const plain = fakeContext();
    drawText(plain.ctx, 'A', 0, 0);
    const shadowed = fakeContext();
    drawText(shadowed.ctx, 'A', 0, 0, { shadow: '#000' });
    expect(shadowed.rects.length).toBe(plain.rects.length * 2);
    expect(shadowed.colors[0]).toBe('#000');
  });
});

describe('HUD formatting', () => {
  it('formats times as m:ss.hh', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(9.5)).toBe('0:09.50');
    expect(formatTime(61.234)).toBe('1:01.23');
    expect(formatTime(-5)).toBe('0:00.00');
    expect(formatTime(600)).toBe('10:00.00');
  });

  it('pads scores to six digits', () => {
    expect(formatScore(0)).toBe('000000');
    expect(formatScore(1234)).toBe('001234');
    expect(formatScore(-50)).toBe('000000');
    expect(formatScore(1234567)).toBe('1234567');
  });
});
