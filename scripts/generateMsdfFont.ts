/**
 * MSDF font smoke-generator.
 *
 * The MSDF atlas is generated at runtime from the bitmap font's own glyph bits (see
 * `src/render/msdfFont.ts`) rather than traced from a font file, so there is nothing to bake into
 * a binary asset and nothing to commit. This script exists purely so the generator can be
 * exercised and inspected from the command line: `npm run generate:fonts` builds the atlas once
 * and prints its size, glyph coverage, and metrics, the same smoke check the unit tests run.
 */
import { buildMsdfAtlasData } from '../src/render/msdfFont';
import { GLYPH_CHARACTERS } from '../src/render/text';

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${String(byteLength)} B`;
  return `${(byteLength / 1024).toFixed(1)} KiB`;
}

const atlas = buildMsdfAtlasData();

console.log('MSDF font atlas (runtime-generated, no binary assets committed)');
console.log(`  size:        ${String(atlas.width)}×${String(atlas.height)} px (RGBA8, ${formatBytes(atlas.pixels.byteLength)})`);
console.log(`  glyphs:      ${String(atlas.glyphs.size)} (source font defines ${String(GLYPH_CHARACTERS.length)})`);
console.log(
  `  metrics:     glyph ${String(atlas.metrics.glyphWidth)}×${String(atlas.metrics.glyphHeight)}, ` +
    `advance ${String(atlas.metrics.advance)}, lineHeight ${String(atlas.metrics.lineHeight)}, ` +
    `supersample ${String(atlas.metrics.supersample)}x`,
);

const missing = GLYPH_CHARACTERS.filter((character) => !atlas.glyphs.has(character));
if (missing.length > 0) {
  console.error(`  MISSING glyphs in atlas: ${missing.join(' ')}`);
  process.exitCode = 1;
} else {
  console.log('  coverage:    OK — every bitmap-font glyph has an atlas cell');
}
