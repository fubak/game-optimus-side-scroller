/**
 * Material atlas generator CLI.
 *
 * `npm run generate:materials [-- --seed=0x1234]` runs the same procedural generator the game
 * will call at runtime (`src/render/materials/generate.ts`), checks that it is actually
 * deterministic (same seed → byte-identical output, twice, in this process), and writes the
 * result to `public/generated/materials/` — one PNG per channel group plus a JSON manifest —
 * purely so a human can look at the textures. The game itself never reads these files; Stage 4
 * wires the runtime atlas straight into WebGL2 textures via `src/render/gl/materialTextures.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png';
import { ALL_MATERIAL_IDS } from '../src/render/materials/types';
import { DEFAULT_MATERIAL_SEED, generateMaterialAtlas, hashMaterialAtlas } from '../src/render/materials/generate';

function parseSeed(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith('--seed='));
  if (flag === undefined) return DEFAULT_MATERIAL_SEED;
  const raw = flag.slice('--seed='.length);
  const parsed = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --seed value: ${raw}`);
  }
  return parsed >>> 0;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'generated', 'materials');

const seed = parseSeed(process.argv.slice(2));

const first = generateMaterialAtlas(seed);
const second = generateMaterialAtlas(seed);
const firstHash = hashMaterialAtlas(first);
const secondHash = hashMaterialAtlas(second);

console.log(`Material atlas — seed 0x${seed.toString(16)}`);
console.log(`Layout: ${String(first.layout.width)}x${String(first.layout.height)} (${String(first.layout.columns)}x${String(first.layout.rows)} cells of ${String(first.layout.tileSize)}px)`);
console.log(`Materials (${String(ALL_MATERIAL_IDS.length)}): ${ALL_MATERIAL_IDS.join(', ')}`);
console.log(`Hash (run 1): ${firstHash}`);
console.log(`Hash (run 2): ${secondHash}`);

if (firstHash !== secondHash) {
  console.error('FAILED — generateMaterialAtlas() is not deterministic for the same seed.');
  process.exitCode = 1;
} else {
  console.log('OK — identical output across two independent generations.');
}

mkdirSync(outDir, { recursive: true });

const { width, height } = first.layout;
writeFileSync(join(outDir, 'albedo.png'), encodePng(first.albedo, width, height));
writeFileSync(join(outDir, 'normal.png'), encodePng(first.normal, width, height));
writeFileSync(join(outDir, 'params.png'), encodePng(first.params, width, height));

const manifest = {
  seed,
  hash: firstHash,
  layout: first.layout,
  materials: ALL_MATERIAL_IDS,
};
writeFileSync(join(outDir, 'atlas.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote albedo.png, normal.png, params.png, atlas.json to ${outDir}`);
