/**
 * Public surface of the WebGL2 render foundation.
 *
 * Everything under `src/render/gl/` is imported through this barrel so call sites depend on a
 * stable module path even as the internal file layout evolves.
 */

export type { GlCaps } from './device';
export { GlDevice, tryCreateWebGL2 } from './device';

export { compileShader, linkProgram, Program } from './program';

export type { TextureOptions } from './texture';
export { Filter, TexFormat, Texture, Wrap } from './texture';

export type { CameraOffset, ViewSize } from './solidBatch';
export { SolidBatch } from './solidBatch';

export { FullscreenBlit } from './blit';
export { GlWorldRenderer, tryCreateGlWorldRenderer } from './GlWorldRenderer';

export type { RGBA as MsdfColor } from './msdfBatch';
export { MsdfBatch } from './msdfBatch';

export type { MaterialTextureSet } from './materialTextures';
export { updateMaterialTextureSet, uploadMaterialAtlas } from './materialTextures';
