/**
 * Character sprite-sheet generator CLI.
 *
 * `npm run generate:spritesheets` bakes the same procedural atlas Enhanced loads at runtime
 * (`src/render/spritesheet/bake.ts`), checks determinism, and writes PNG previews under
 * `public/generated/spritesheets/` for art review. The game never reads these files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png';
import {
  ENEMY_CLIPS,
  OPTIMUS_CLIPS,
  buildCharacterAtlas,
  hashCharacterAtlas,
} from '../src/render/spritesheet';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'generated', 'spritesheets');

const first = buildCharacterAtlas();
const second = buildCharacterAtlas();
const firstHash = hashCharacterAtlas(first);
const secondHash = hashCharacterAtlas(second);

if (firstHash !== secondHash) {
  throw new Error(`Character atlas is not deterministic: ${firstHash} vs ${secondHash}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'albedo.png'), encodePng(first.albedo, first.width, first.height));
writeFileSync(join(outDir, 'emissive.png'), encodePng(first.emissive, first.width, first.height));

const manifest = {
  hash: firstHash,
  width: first.width,
  height: first.height,
  cellWidth: first.cellWidth,
  cellHeight: first.cellHeight,
  clips: [...OPTIMUS_CLIPS, ...ENEMY_CLIPS].map((clip) => ({
    id: clip.id,
    frameCount: clip.frameCount,
    fps: clip.fps,
    loop: clip.loop,
    drawSize: first.drawSizes.get(clip.id) ?? null,
  })),
};
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Character atlas — ${String(first.width)}x${String(first.height)} hash ${firstHash}`);
console.log(`Clips: ${String(OPTIMUS_CLIPS.length + ENEMY_CLIPS.length)} (Optimus + enemies)`);
console.log(`Wrote previews to ${outDir}`);
