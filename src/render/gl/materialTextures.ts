/**
 * GPU upload for a procedural material atlas.
 *
 * Thin wrapper around {@link Texture} that turns a {@link MaterialAtlas} (three plain
 * `Uint8Array`s from `src/render/materials/generate.ts`) into three bound-and-ready WebGL2
 * textures. Nothing here samples or binds these into a draw call — that is Stage 4's job, once
 * `GlWorldRenderer` actually draws tiles with materials instead of the Classic Canvas2D painter.
 */

import type { MaterialAtlas } from '../materials/types';
import { Filter, TexFormat, Texture, Wrap } from './texture';

/** The three GPU textures produced from one {@link MaterialAtlas}, all the same pixel size. */
export interface MaterialTextureSet {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly params: Texture;
  /** Switch every channel's sampling filter together (see `GlWorldRenderer`'s tile-filter logic). */
  setFilter(filter: Filter): void;
  dispose(): void;
}

/** Upload every channel of a material atlas into fresh nearest-filtered, clamped textures. */
export function uploadMaterialAtlas(gl: WebGL2RenderingContext, atlas: MaterialAtlas): MaterialTextureSet {
  const { width, height } = atlas.layout;
  const options = { filter: Filter.Nearest, wrap: Wrap.Clamp };

  const albedo = new Texture(gl, TexFormat.RGBA8, options);
  albedo.uploadRGBA(atlas.albedo, width, height);

  const normal = new Texture(gl, TexFormat.RGBA8, options);
  normal.uploadRGBA(atlas.normal, width, height);

  const params = new Texture(gl, TexFormat.RGBA8, options);
  params.uploadRGBA(atlas.params, width, height);

  return {
    albedo,
    normal,
    params,
    setFilter(filter: Filter): void {
      albedo.setFilter(filter);
      normal.setFilter(filter);
      params.setFilter(filter);
    },
    dispose(): void {
      albedo.dispose();
      normal.dispose();
      params.dispose();
    },
  };
}

/** Re-upload a set's textures in place from a newer atlas (e.g. a hot-reloaded seed in dev). */
export function updateMaterialTextureSet(set: MaterialTextureSet, atlas: MaterialAtlas): void {
  const { width, height } = atlas.layout;
  set.albedo.uploadRGBA(atlas.albedo, width, height);
  set.normal.uploadRGBA(atlas.normal, width, height);
  set.params.uploadRGBA(atlas.params, width, height);
}
