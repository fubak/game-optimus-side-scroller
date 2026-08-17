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

export type { CharacterTextureSet } from './characterTextures';
export { uploadCharacterAtlas } from './characterTextures';

export type { AttachmentSpec } from './renderTarget';
export { RenderTarget } from './renderTarget';

export { GpuTimer } from './gpuTimer';

export type { CollectLightsParams } from './lights';
export { LightList, MAX_LIGHTS, collectLights } from './lights';

export type { UvRect } from './tileBatch';
export { TileBatch } from './tileBatch';

export type { GBufferQuadStyle } from './gbufferBatch';
export { GBufferBatch } from './gbufferBatch';

export { SpriteGBufferBatch } from './spriteGBufferBatch';

export { BackgroundBatch } from './backgroundBatch';

export type { ParticleBlendGroup, ParticleShape } from './particleBatch';
export { ParticleBatch, particleBlendGroup, shapeValue } from './particleBatch';

export type { LightingPassInputs } from './lightingPass';
export { LightingPass } from './lightingPass';

export type { BloomInputs } from './post/bloom';
export { BloomPass } from './post/bloom';

export type { CompositeInputs } from './post/composite';
export { CompositePass, tonemapOperatorIndex } from './post/composite';

export { TonemapPass } from './tonemap';
