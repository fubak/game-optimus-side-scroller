/**
 * GPU upload for a procedural character sprite atlas (albedo + emissive).
 */

import type { CharacterAtlas } from '../spritesheet/types';
import { Filter, TexFormat, Texture, Wrap } from './texture';

export interface CharacterTextureSet {
  readonly albedo: Texture;
  readonly emissive: Texture;
  dispose(): void;
}

export function uploadCharacterAtlas(gl: WebGL2RenderingContext, atlas: CharacterAtlas): CharacterTextureSet {
  const options = { filter: Filter.Linear, wrap: Wrap.Clamp };
  const albedo = new Texture(gl, TexFormat.RGBA8, options);
  albedo.uploadRGBA(atlas.albedo, atlas.width, atlas.height);
  const emissive = new Texture(gl, TexFormat.RGBA8, options);
  emissive.uploadRGBA(atlas.emissive, atlas.width, atlas.height);
  return {
    albedo,
    emissive,
    dispose(): void {
      albedo.dispose();
      emissive.dispose();
    },
  };
}
