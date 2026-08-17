import { describe, expect, it, vi } from 'vitest';
import { uploadMaterialAtlas } from '../../src/render/gl/materialTextures';
import {
  DEFAULT_MATERIAL_SEED,
  MATERIAL_TILE_PX,
  generateMaterialAtlas,
  hashBytes,
  hashMaterialAtlas,
} from '../../src/render/materials/generate';
import { materialForTile, materialForTileAt, tileVariation } from '../../src/render/materials/tileMaterial';
import { ALL_MATERIAL_IDS } from '../../src/render/materials/types';
import { ALL_TILE_KINDS, TileKind } from '../../src/game/tiles';

/**
 * Reference copy of the private `tileHash` in `src/render/tiles.ts`. `tileVariation` must match
 * it exactly — the two live in different modules on purpose (see tileMaterial.ts) but a level's
 * cosmetic rivets and its material variation should agree on which tiles look "the same".
 */
function referenceTileHash(tx: number, ty: number): number {
  let hash = (tx * 73856093) ^ (ty * 19349663);
  hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  return (hash ^ (hash >>> 15)) >>> 0;
}

describe('generateMaterialAtlas', () => {
  it('is deterministic: the same seed always produces identical bytes', () => {
    const a = generateMaterialAtlas(0x1234abcd);
    const b = generateMaterialAtlas(0x1234abcd);
    expect(a.albedo).toEqual(b.albedo);
    expect(a.normal).toEqual(b.normal);
    expect(a.params).toEqual(b.params);
    expect(hashMaterialAtlas(a)).toBe(hashMaterialAtlas(b));
  });

  it('produces different bytes for a different seed', () => {
    const a = generateMaterialAtlas(1);
    const b = generateMaterialAtlas(2);
    expect(hashMaterialAtlas(a)).not.toBe(hashMaterialAtlas(b));
  });

  it('defaults to DEFAULT_MATERIAL_SEED and matches an explicit call with that seed', () => {
    const a = generateMaterialAtlas();
    const b = generateMaterialAtlas(DEFAULT_MATERIAL_SEED);
    expect(hashMaterialAtlas(a)).toBe(hashMaterialAtlas(b));
    expect(a.seed).toBe(DEFAULT_MATERIAL_SEED);
  });

  it('lays out one tileSize-square cell per material, all inside the atlas bounds', () => {
    const atlas = generateMaterialAtlas(7);
    const { layout } = atlas;
    expect(layout.tileSize).toBe(MATERIAL_TILE_PX);
    for (const id of ALL_MATERIAL_IDS) {
      const rect = layout.rects[id];
      expect(rect).toBeDefined();
      expect(rect.width).toBe(MATERIAL_TILE_PX);
      expect(rect.height).toBe(MATERIAL_TILE_PX);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
    expect(atlas.albedo.length).toBe(layout.width * layout.height * 4);
    expect(atlas.normal.length).toBe(layout.width * layout.height * 4);
    expect(atlas.params.length).toBe(layout.width * layout.height * 4);
  });

  it('writes fully opaque albedo, normal and params alpha for every material cell', () => {
    // Only the grating/catwalk "hole" texels intentionally carry partial albedo alpha; the
    // normal and params channels are always opaque so a shader can rely on their alpha being 255.
    const atlas = generateMaterialAtlas(42);
    const { layout } = atlas;
    for (const id of ALL_MATERIAL_IDS) {
      const rect = layout.rects[id];
      for (let y = 0; y < rect.height; y += 8) {
        for (let x = 0; x < rect.width; x += 8) {
          const index = ((rect.y + y) * layout.width + (rect.x + x)) * 4;
          expect(atlas.normal[index + 3]).toBe(255);
          expect(atlas.params[index + 3]).toBe(255);
        }
      }
    }
  });

  it('produces roughly unit-length normals (xyz decoded from 0..255 back to -1..1)', () => {
    const atlas = generateMaterialAtlas(99);
    const { layout } = atlas;
    const rect = layout.rects[ALL_MATERIAL_IDS[0]!];
    for (let y = 0; y < rect.height; y += 4) {
      for (let x = 0; x < rect.width; x += 4) {
        const index = ((rect.y + y) * layout.width + (rect.x + x)) * 4;
        const nx = (atlas.normal[index]! / 255) * 2 - 1;
        const ny = (atlas.normal[index + 1]! / 255) * 2 - 1;
        const nz = (atlas.normal[index + 2]! / 255) * 2 - 1;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        expect(length).toBeGreaterThan(0.9);
        expect(length).toBeLessThan(1.1);
        expect(nz).toBeGreaterThan(0);
      }
    }
  });

  it('keeps roughness/ao/metallic within the 0..255 byte range (no NaN/overflow from painters)', () => {
    // One assertion over the whole (several-hundred-thousand-byte) buffer instead of three `expect`
    // calls per byte — thousands of individual assertions over a Uint8Array this size is what was
    // timing out the suite, not the invariant itself (which a single pass still checks in full).
    const atlas = generateMaterialAtlas(1337);
    let invalidCount = 0;
    for (const value of atlas.params) {
      if (!(value >= 0 && value <= 255) || Number.isNaN(value)) invalidCount += 1;
    }
    expect(invalidCount).toBe(0);
  });
});

describe('hashBytes / hashMaterialAtlas', () => {
  it('hashes empty and non-empty buffers without throwing', () => {
    expect(() => hashBytes(new Uint8Array(0))).not.toThrow();
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([3, 2, 1])));
  });
});

describe('tileVariation', () => {
  it('matches the reference implementation of tiles.ts tileHash bit-for-bit', () => {
    for (let tx = -3; tx < 12; tx += 1) {
      for (let ty = -3; ty < 12; ty += 1) {
        expect(tileVariation(tx, ty)).toBe(referenceTileHash(tx, ty));
      }
    }
  });

  it('is stable across repeated calls and always a non-negative 32-bit integer', () => {
    const first = tileVariation(5, 9);
    const second = tileVariation(5, 9);
    expect(first).toBe(second);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0xffffffff);
  });

  it('varies across tile coordinates (not a constant)', () => {
    const values = new Set<number>();
    for (let tx = 0; tx < 20; tx += 1) {
      values.add(tileVariation(tx, 0));
    }
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('materialForTile', () => {
  it('maps every TileKind to a material without throwing', () => {
    for (const kind of ALL_TILE_KINDS) {
      expect(() => materialForTile(kind)).not.toThrow();
      const material = materialForTile(kind);
      expect(ALL_MATERIAL_IDS).toContain(material);
    }
  });

  it('rejects unknown tile kinds loudly, like tileFlags does', () => {
    expect(() => materialForTile(99 as TileKind)).toThrow(/Unhandled tile kind/);
  });

  it('gives conveyors the same material regardless of direction', () => {
    expect(materialForTile(TileKind.ConveyorLeft)).toBe(materialForTile(TileKind.ConveyorRight));
  });
});

describe('materialForTileAt', () => {
  it('maps every TileKind, at several positions, to a material without throwing', () => {
    for (const kind of ALL_TILE_KINDS) {
      for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [7, 3], [-2, 5]] as const) {
        expect(() => materialForTileAt(kind, tx, ty)).not.toThrow();
        expect(ALL_MATERIAL_IDS).toContain(materialForTileAt(kind, tx, ty));
      }
    }
  });

  it('is deterministic for a given tile kind and position', () => {
    expect(materialForTileAt(TileKind.Solid, 4, 4)).toBe(materialForTileAt(TileKind.Solid, 4, 4));
  });

  it('varies the Solid skin across positions using tileVariation', () => {
    const seen = new Set<string>();
    for (let tx = 0; tx < 30; tx += 1) {
      seen.add(materialForTileAt(TileKind.Solid, tx, 0));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rejects unknown tile kinds loudly', () => {
    expect(() => materialForTileAt(99 as TileKind, 0, 0)).toThrow(/Unhandled tile kind/);
  });
});

function createMockGl(): { gl: WebGL2RenderingContext; texImage2D: ReturnType<typeof vi.fn>; deleteTexture: ReturnType<typeof vi.fn> } {
  const texImage2D = vi.fn();
  const deleteTexture = vi.fn();
  const glLike = {
    TEXTURE_2D: 0x0de1,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    RGBA16F: 0x881a,
    HALF_FLOAT: 0x140b,
    R8: 0x8229,
    RED: 0x1903,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    REPEAT: 0x2901,
    MIRRORED_REPEAT: 0x8370,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D,
    deleteTexture,
    activeTexture: vi.fn(),
  };
  return { gl: glLike as unknown as WebGL2RenderingContext, texImage2D, deleteTexture };
}

describe('uploadMaterialAtlas', () => {
  it('uploads albedo, normal and params into three distinct textures at the atlas size', () => {
    const atlas = generateMaterialAtlas(11);
    const { gl, texImage2D, deleteTexture } = createMockGl();
    const set = uploadMaterialAtlas(gl, atlas);

    expect(set.albedo).not.toBe(set.normal);
    expect(set.normal).not.toBe(set.params);
    expect(texImage2D).toHaveBeenCalledTimes(3);
    for (const call of texImage2D.mock.calls) {
      expect(call[3]).toBe(atlas.layout.width);
      expect(call[4]).toBe(atlas.layout.height);
    }

    set.dispose();
    expect(deleteTexture).toHaveBeenCalledTimes(3);
  });
});
