/**
 * The deferred rendering pipeline.
 *
 * Frame structure:
 *
 * ```
 *  1. G-buffer          geometry -> albedo | normal+height | material | depth
 *  2. Occluder mask     shadow casters -> half-res coverage
 *  3. Lighting          G-buffer + lights -> HDR accumulation
 *  4. God rays          occluder mask -> radial light shafts
 *  5. Fog               HDR + depth -> atmospheric attenuation
 *  6. Bright pass       HDR -> bloom source
 *  7. Bloom             dual-Kawase down/up chain
 *  8. Composite         everything -> tonemap -> grade -> grain -> backbuffer
 * ```
 *
 * Every stage can be skipped by the quality tiers, and each writes to a
 * pool-managed target so that a resize or a dynamic-resolution change is one
 * call rather than a source of leaks.
 */

import { Device, BlendMode } from '../gfx/device.ts';
import { Program } from '../gfx/program.ts';
import { RenderTarget, RenderTargetPool, halfRes, divRes } from '../gfx/rendertarget.ts';
import { Texture, TexFormat, Filter, Wrap } from '../gfx/texture.ts';
import { FullscreenPass, FULLSCREEN_VS } from '../gfx/fullscreen.ts';
import { SpriteBatch } from '../gfx/batch.ts';
import { generateBlueNoise, blueNoiseToRGBA, identityLUT } from '../gfx/bluenoise.ts';
import { SPRITE_VS, SPRITE_FS, OCCLUDER_FS } from '../shaders/sprite.ts';
import { LIGHTING_FS } from '../shaders/lighting.ts';
import {
  BRIGHT_PASS_FS,
  KAWASE_DOWN_FS,
  KAWASE_UP_FS,
  GODRAYS_FS,
  FOG_FS,
  COMPOSITE_FS,
  BLUR_FS,
  COPY_FS,
} from '../shaders/post.ts';
import { LightList } from './lights.ts';
import { Quality, QUALITY_PRESETS, type QualitySettings } from '../core/config.ts';
import type { Camera } from '../scene/camera.ts';

/** Per-biome atmospheric settings that drive the lighting and post stages. */
export interface Atmosphere {
  ambientSky: [number, number, number];
  ambientSkyIntensity: number;
  ambientGround: [number, number, number];
  ambientGroundIntensity: number;
  rimColor: [number, number, number];
  rimStrength: number;

  fogColor: [number, number, number];
  fogDensity: number;
  fogHeightFalloff: number;
  fogNoiseStrength: number;
  fogWindX: number;
  fogWindY: number;

  /** God-ray source in world metres; usually the sun or a ceiling opening. */
  godRayX: number;
  godRayY: number;
  godRayColor: [number, number, number];
  godRayDensity: number;
  godRayDecay: number;
  godRayWeight: number;
  godRayExposure: number;

  bloomThreshold: number;
  bloomKnee: number;
  bloomIntensity: number;

  /**
   * Multiplier on emissive surfaces. 1.0 means a fully-emissive surface renders
   * at exactly its authored albedo. Values above 1 push emissives past the
   * bloom threshold.
   */
  emissiveScale: number;

  exposure: number;
  contrast: number;
  saturation: number;
  lift: number;
  vignette: number;
  chromaticAberration: number;
  barrelDistortion: number;
  grainAmount: number;
  gradeMix: number;
}

export const DEFAULT_ATMOSPHERE: Atmosphere = {
  ambientSky: [0.28, 0.36, 0.52],
  ambientSkyIntensity: 0.35,
  ambientGround: [0.16, 0.09, 0.07],
  ambientGroundIntensity: 0.22,
  rimColor: [0.45, 0.72, 0.95],
  rimStrength: 0.35,

  fogColor: [0.3, 0.22, 0.24],
  fogDensity: 0.16,
  fogHeightFalloff: 1.2,
  fogNoiseStrength: 0.45,
  fogWindX: 0.6,
  fogWindY: -0.1,

  godRayX: 0,
  godRayY: -14,
  godRayColor: [1.0, 0.72, 0.45],
  godRayDensity: 0.72,
  godRayDecay: 0.94,
  godRayWeight: 0.42,
  godRayExposure: 0.5,

  bloomThreshold: 0.85,
  bloomKnee: 0.35,
  bloomIntensity: 0.7,
  emissiveScale: 1.0,

  exposure: 1.15,
  contrast: 1.06,
  saturation: 1.08,
  lift: 0.0,
  vignette: 0.42,
  chromaticAberration: 0.0022,
  barrelDistortion: 0.012,
  grainAmount: 0.032,
  gradeMix: 1.0,
};

/** Supplied by the game each frame to describe what to draw. */
export interface FrameRequest {
  camera: Camera;
  atmosphere: Atmosphere;
  lights: LightList;
  /** Draw all geometry into the G-buffer. */
  drawGeometry(batch: SpriteBatch): void;
  /** Draw shadow-casting silhouettes into the occluder mask. */
  drawOccluders(batch: SpriteBatch): void;
  /** Optional screen-space distortion writes (heat haze, shockwaves). */
  drawDistortion?(batch: SpriteBatch): void;
  /** Draw unlit UI over the composited image. */
  drawUI?(batch: SpriteBatch): void;
  timeSeconds: number;
}

const BLOOM_LEVELS_MAX = 6;

export class Pipeline {
  private readonly pool: RenderTargetPool;
  private readonly fullscreen: FullscreenPass;
  readonly batch: SpriteBatch;

  // Targets
  private gbuffer!: RenderTarget;
  private occluder!: RenderTarget;
  private lightTarget!: RenderTarget;
  private godRayTarget!: RenderTarget;
  private distortionTarget!: RenderTarget;
  private sceneTarget!: RenderTarget;
  private fogTarget!: RenderTarget;
  private bloomChain: RenderTarget[] = [];

  // Programs
  private spriteProgram!: Program;
  private occluderProgram!: Program;
  private lightingProgram!: Program;
  private brightPassProgram!: Program;
  private kawaseDownProgram!: Program;
  private kawaseUpProgram!: Program;
  private godRayProgram!: Program;
  private fogProgram!: Program;
  private compositeProgram!: Program;
  private copyProgram!: Program;
  private blurProgram!: Program;

  private blueNoise!: Texture;
  private gradeLUT!: Texture;
  private fogNoise!: Texture;

  private quality: Quality = Quality.High;
  private settings: QualitySettings = QUALITY_PRESETS[Quality.High];

  /** Internal render resolution, after quality and dynamic scaling. */
  private renderWidth = 1920;
  private renderHeight = 1080;
  private displayWidth = 1920;
  private displayHeight = 1080;

  /** Dynamic resolution factor, adjusted to hold the frame budget. */
  private dynamicScale = 1;

  /** Fullscreen passes executed in the last frame, for the budget audit. */
  fullscreenPasses = 0;

  /** Debug view selector; 0 renders the final image. */
  debugView = 0;

  constructor(readonly device: Device) {
    this.pool = new RenderTargetPool(device);
    this.fullscreen = new FullscreenPass(device);
    this.batch = new SpriteBatch(device, 16384);

    this.createPrograms();
    this.createTextures();
    this.createTargets();
  }

  private createPrograms(): void {
    const device = this.device;

    this.spriteProgram = new Program(device, SPRITE_VS, SPRITE_FS, { name: 'sprite-gbuffer' });
    this.occluderProgram = new Program(device, SPRITE_VS, OCCLUDER_FS, { name: 'occluder' });
    this.brightPassProgram = new Program(device, FULLSCREEN_VS, BRIGHT_PASS_FS, {
      name: 'bright-pass',
    });
    this.kawaseDownProgram = new Program(device, FULLSCREEN_VS, KAWASE_DOWN_FS, {
      name: 'kawase-down',
    });
    this.kawaseUpProgram = new Program(device, FULLSCREEN_VS, KAWASE_UP_FS, { name: 'kawase-up' });
    this.fogProgram = new Program(device, FULLSCREEN_VS, FOG_FS, { name: 'fog' });
    this.copyProgram = new Program(device, FULLSCREEN_VS, COPY_FS, { name: 'copy' });
    this.blurProgram = new Program(device, FULLSCREEN_VS, BLUR_FS, { name: 'blur' });

    this.rebuildQualityPrograms();
  }

  /**
   * Rebuilds the shaders whose cost is governed by compile-time constants.
   *
   * Shadow step count and god-ray sample count are `#define`s rather than
   * uniforms so the GPU can fully unroll the loops. Changing quality therefore
   * costs a recompile, which is fine: it happens on a menu interaction, not per
   * frame.
   */
  private rebuildQualityPrograms(): void {
    this.lightingProgram?.dispose();
    this.godRayProgram?.dispose();
    this.compositeProgram?.dispose();

    this.lightingProgram = new Program(this.device, FULLSCREEN_VS, LIGHTING_FS, {
      name: 'lighting',
      defines: {
        MAX_LIGHTS: this.lightsUniformCapacity,
        SHADOW_STEPS: this.settings.shadowSteps,
      },
    });

    this.godRayProgram = new Program(this.device, FULLSCREEN_VS, GODRAYS_FS, {
      name: 'godrays',
      defines: { GODRAY_SAMPLES: this.settings.godRaySamples },
    });

    this.compositeProgram = new Program(this.device, FULLSCREEN_VS, COMPOSITE_FS, {
      name: 'composite',
      defines: {
        ENABLE_GRAIN: this.settings.filmGrain,
        ENABLE_ABERRATION: this.settings.chromaticAberration,
      },
    });
  }

  private readonly lightsUniformCapacity = 24;

  private createTextures(): void {
    const device = this.device;

    const size = 64;
    const mask = generateBlueNoise(size, 0xb1e5);
    this.blueNoise = new Texture(device, size, size, {
      format: TexFormat.RGBA8,
      filter: Filter.Nearest,
      wrap: Wrap.Repeat,
      label: 'blue-noise',
    });
    this.blueNoise.upload(blueNoiseToRGBA(mask, size));

    this.gradeLUT = new Texture(device, 32 * 32, 32, {
      format: TexFormat.RGBA8,
      filter: Filter.Linear,
      wrap: Wrap.Clamp,
      label: 'grade-lut',
    });
    this.gradeLUT.upload(identityLUT(32));

    // A tiling value-noise texture for the fog. Generated rather than shipped,
    // for the same self-containment reason as the blue noise.
    const fogSize = 128;
    const fogPixels = new Uint8Array(fogSize * fogSize * 4);
    const fogMask = generateBlueNoise(fogSize, 0xf0);
    for (let i = 0; i < fogSize * fogSize; i++) {
      // Smooth the blue noise into soft blobs; raw blue noise is far too
      // high-frequency to read as drifting air.
      const x = i % fogSize;
      const y = (i / fogSize) | 0;
      let sum = 0;
      let weight = 0;
      const radius = 4;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const w = 1 - Math.hypot(dx, dy) / (radius + 1);
          if (w <= 0) continue;
          const sx = (x + dx + fogSize) % fogSize;
          const sy = (y + dy + fogSize) % fogSize;
          sum += fogMask[sy * fogSize + sx]! * w;
          weight += w;
        }
      }
      const value = weight > 0 ? sum / weight : 128;
      fogPixels[i * 4] = value;
      fogPixels[i * 4 + 1] = value;
      fogPixels[i * 4 + 2] = value;
      fogPixels[i * 4 + 3] = 255;
    }
    this.fogNoise = new Texture(device, fogSize, fogSize, {
      format: TexFormat.RGBA8,
      filter: Filter.Linear,
      wrap: Wrap.Repeat,
      label: 'fog-noise',
    });
    this.fogNoise.upload(fogPixels);
  }

  private createTargets(): void {
    const w = this.renderWidth;
    const h = this.renderHeight;

    // The four deferred attachments. Normals get 8 bits per channel, which is
    // enough for 2D surfaces where the normal never strays far from facing the
    // camera and banding would be hidden by the lighting anyway.
    this.gbuffer = this.pool.create(
      'gbuffer',
      [
        { format: TexFormat.RGBA8, filter: Filter.Nearest, label: 'albedo' },
        { format: TexFormat.RGBA8, filter: Filter.Nearest, label: 'normal' },
        { format: TexFormat.RGBA8, filter: Filter.Nearest, label: 'material' },
        { format: TexFormat.RGBA8, filter: Filter.Nearest, label: 'depth' },
      ],
      w,
      h,
    );

    // Half resolution: shadows and light shafts are soft enough that the
    // missing detail is invisible, and this is the single biggest saving in
    // the whole frame.
    this.occluder = this.pool.create(
      'occluder',
      [{ format: TexFormat.R8, filter: Filter.Linear }],
      w,
      h,
      halfRes,
    );

    this.lightTarget = this.pool.create(
      'light',
      [{ format: TexFormat.RGBA16F, filter: Filter.Linear }],
      w,
      h,
    );

    this.fogTarget = this.pool.create(
      'fog',
      [{ format: TexFormat.RGBA16F, filter: Filter.Linear }],
      w,
      h,
    );

    this.sceneTarget = this.pool.create(
      'scene',
      [{ format: TexFormat.RGBA16F, filter: Filter.Linear }],
      w,
      h,
    );

    this.godRayTarget = this.pool.create(
      'godrays',
      [{ format: TexFormat.RGBA16F, filter: Filter.Linear }],
      w,
      h,
      halfRes,
    );

    this.distortionTarget = this.pool.create(
      'distortion',
      [{ format: TexFormat.RG8, filter: Filter.Linear }],
      w,
      h,
      halfRes,
    );

    this.bloomChain = [];
    for (let i = 0; i < BLOOM_LEVELS_MAX; i++) {
      this.bloomChain.push(
        this.pool.create(
          `bloom${i}`,
          [{ format: TexFormat.RGBA16F, filter: Filter.Linear }],
          w,
          h,
          divRes(Math.pow(2, i + 1)),
        ),
      );
    }
  }

  /** Resize to a new display resolution. */
  resize(displayWidth: number, displayHeight: number): void {
    this.displayWidth = Math.max(1, Math.floor(displayWidth));
    this.displayHeight = Math.max(1, Math.floor(displayHeight));
    this.applyResolution();
  }

  private applyResolution(): void {
    const scale = this.settings.renderScale * this.dynamicScale;
    const w = Math.max(1, Math.floor(this.displayWidth * scale));
    const h = Math.max(1, Math.floor(this.displayHeight * scale));
    if (w === this.renderWidth && h === this.renderHeight) return;
    this.renderWidth = w;
    this.renderHeight = h;
    this.pool.resizeAll(w, h);
  }

  setQuality(quality: Quality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.settings = QUALITY_PRESETS[quality];
    this.rebuildQualityPrograms();
    this.applyResolution();
  }

  getQuality(): Quality {
    return this.quality;
  }

  getSettings(): QualitySettings {
    return this.settings;
  }

  /**
   * Nudge the dynamic resolution scale toward holding a frame-time target.
   *
   * Deliberately asymmetric: resolution drops quickly when frames are slow (the
   * player is already suffering) but recovers slowly, because oscillating
   * resolution is far more noticeable than a consistently slightly-soft image.
   */
  updateDynamicResolution(frameMs: number, targetMs: number): void {
    const previous = this.dynamicScale;
    if (frameMs > targetMs * 1.2) {
      this.dynamicScale = Math.max(0.6, this.dynamicScale - 0.05);
    } else if (frameMs < targetMs * 0.75) {
      this.dynamicScale = Math.min(1, this.dynamicScale + 0.01);
    }
    if (Math.abs(previous - this.dynamicScale) > 0.001) this.applyResolution();
  }

  get internalResolution(): [number, number] {
    return [this.renderWidth, this.renderHeight];
  }

  /** Render one frame. */
  render(request: FrameRequest): void {
    const device = this.device;
    const gl = device.gl;
    const { camera, atmosphere, lights } = request;

    device.resetFrameStats();
    this.fullscreenPasses = 0;

    camera.setViewport(this.renderWidth, this.renderHeight);

    lights.pack(camera, this.settings.shadowCasters);

    this.renderGBuffer(request);
    this.renderOccluders(request);
    this.renderDistortion(request);
    this.renderLighting(request);
    this.renderGodRays(request);
    this.renderFog(request);
    this.renderBloom(atmosphere);
    this.renderComposite(request);

    // The UI is deliberately outside the graded, tonemapped image: HUD elements
    // must stay legible and colour-accurate regardless of the biome's grade.
    if (request.drawUI) {
      device.bindFramebuffer(null);
      device.setViewport(0, 0, this.displayWidth, this.displayHeight);
      this.batch.begin(this.spriteProgram, BlendMode.Premultiplied);
      this.spriteProgram.setMat3('uViewProjection', camera.viewProjection);
      this.spriteProgram.setVec4('uLayerTint', 1, 1, 1, 1);
      this.spriteProgram.setFloat('uMaterialId', 0);
      request.drawUI(this.batch);
      this.batch.end();
    }

    void gl;
  }

  private renderGBuffer(request: FrameRequest): void {
    const gl = this.device.gl;
    this.gbuffer.bind();

    // Each attachment needs its own clear value. A normal buffer cleared to
    // black would decode as a normal pointing down-left, lighting every empty
    // pixel incorrectly; it must clear to the packed value for "facing camera".
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, 0, 1]);
    gl.clearBufferfv(gl.COLOR, 2, [0.6, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 3, [0, 0, 0, 0]);

    this.batch.begin(this.spriteProgram, BlendMode.Premultiplied);
    this.spriteProgram.setMat3('uViewProjection', request.camera.viewProjection);
    this.spriteProgram.setVec4('uLayerTint', 1, 1, 1, 1);
    this.spriteProgram.setFloat('uMaterialId', 0);
    request.drawGeometry(this.batch);
    this.batch.end();
  }

  private renderOccluders(request: FrameRequest): void {
    this.occluder.bindAndClear(0, 0, 0, 0);
    if (this.settings.shadowSteps === 0 && this.settings.godRaySamples === 0) return;

    this.batch.begin(this.occluderProgram, BlendMode.Premultiplied);
    this.occluderProgram.setMat3('uViewProjection', request.camera.viewProjection);
    request.drawOccluders(this.batch);
    this.batch.end();
  }

  private renderDistortion(request: FrameRequest): void {
    // 0.5 is the neutral offset: the composite decodes this channel as
    // `value * 2 - 1`, so a mid-grey clear means "no displacement".
    this.distortionTarget.bindAndClear(0.5, 0.5, 0, 1);
    if (!request.drawDistortion) return;

    this.batch.begin(this.spriteProgram, BlendMode.Alpha);
    this.spriteProgram.setMat3('uViewProjection', request.camera.viewProjection);
    this.spriteProgram.setVec4('uLayerTint', 1, 1, 1, 1);
    this.spriteProgram.setFloat('uMaterialId', 0);
    request.drawDistortion(this.batch);
    this.batch.end();
  }

  private renderLighting(request: FrameRequest): void {
    const { atmosphere, lights, camera } = request;
    this.lightTarget.bind();
    const program = this.lightingProgram;
    program.use();

    program.setTexture('uAlbedo', 0, this.gbuffer.textures[0]!.handle);
    program.setTexture('uNormal', 1, this.gbuffer.textures[1]!.handle);
    program.setTexture('uMaterial', 2, this.gbuffer.textures[2]!.handle);
    program.setTexture('uDepth', 3, this.gbuffer.textures[3]!.handle);
    program.setTexture('uOccluder', 4, this.occluder.texture.handle);
    program.setTexture('uBlueNoise', 5, this.blueNoise.handle);

    program.setVec4Array('uLightPosition', lights.positionData);
    program.setVec4Array('uLightColor', lights.colorData);
    program.setVec4Array('uLightParams', lights.paramData);
    program.setInt('uLightCount', lights.count);

    program.setVec4(
      'uAmbientSky',
      atmosphere.ambientSky[0],
      atmosphere.ambientSky[1],
      atmosphere.ambientSky[2],
      atmosphere.ambientSkyIntensity,
    );
    program.setVec4(
      'uAmbientGround',
      atmosphere.ambientGround[0],
      atmosphere.ambientGround[1],
      atmosphere.ambientGround[2],
      atmosphere.ambientGroundIntensity,
    );
    program.setVec4(
      'uRim',
      atmosphere.rimColor[0],
      atmosphere.rimColor[1],
      atmosphere.rimColor[2],
      atmosphere.rimStrength,
    );

    program.setVec2('uResolution', this.renderWidth, this.renderHeight);
    program.setFloat('uTime', request.timeSeconds);
    // Aspect correction keeps a light's reach circular rather than elliptical.
    program.setVec2('uAspect', camera.aspect, 1);
    program.setFloat('uEmissiveScale', atmosphere.emissiveScale);

    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;
  }

  private renderGodRays(request: FrameRequest): void {
    this.godRayTarget.bindAndClear(0, 0, 0, 1);
    if (this.settings.godRaySamples === 0 || !this.settings.volumetrics) return;

    const { atmosphere, camera } = request;
    const screen = { x: 0, y: 0 };
    camera.worldToScreen(atmosphere.godRayX, atmosphere.godRayY, screen);

    const program = this.godRayProgram;
    program.use();
    program.setTexture('uOccluder', 0, this.occluder.texture.handle);
    program.setTexture('uBlueNoise', 1, this.blueNoise.handle);
    program.setVec2('uLightScreenPos', screen.x, screen.y);
    program.setFloat('uDensity', atmosphere.godRayDensity);
    program.setFloat('uDecay', atmosphere.godRayDecay);
    program.setFloat('uWeight', atmosphere.godRayWeight);
    program.setFloat('uExposure', atmosphere.godRayExposure);
    program.setVec3(
      'uColor',
      atmosphere.godRayColor[0],
      atmosphere.godRayColor[1],
      atmosphere.godRayColor[2],
    );
    program.setVec2('uResolution', this.renderWidth, this.renderHeight);
    program.setFloat('uTime', request.timeSeconds);

    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;
  }

  private renderFog(request: FrameRequest): void {
    const { atmosphere } = request;
    const target = this.settings.volumetrics ? this.fogTarget : this.sceneTarget;
    target.bind();

    const program = this.fogProgram;
    program.use();
    program.setTexture('uScene', 0, this.lightTarget.texture.handle);
    program.setTexture('uDepth', 1, this.gbuffer.textures[3]!.handle);
    program.setTexture('uNoise', 2, this.fogNoise.handle);
    program.setTexture('uMaterial', 3, this.gbuffer.textures[2]!.handle);
    program.setVec3(
      'uFogColor',
      atmosphere.fogColor[0],
      atmosphere.fogColor[1],
      atmosphere.fogColor[2],
    );
    program.setFloat('uDensity', this.settings.volumetrics ? atmosphere.fogDensity : 0);
    program.setFloat('uHeightFalloff', atmosphere.fogHeightFalloff);
    program.setFloat('uNoiseStrength', atmosphere.fogNoiseStrength);
    program.setFloat('uTime', request.timeSeconds);
    program.setVec2('uWind', atmosphere.fogWindX, atmosphere.fogWindY);

    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;

    if (this.settings.volumetrics) {
      // Resolve into the scene target so downstream stages have one input.
      this.sceneTarget.bind();
      this.copyProgram.use();
      this.copyProgram.setTexture('uSource', 0, this.fogTarget.texture.handle);
      this.copyProgram.setFloat('uScale', 1);
      this.fullscreen.draw();
      this.fullscreenPasses++;
    }
  }

  private renderBloom(atmosphere: Atmosphere): void {
    const levels = Math.min(this.settings.bloomLevels, BLOOM_LEVELS_MAX);
    if (levels === 0) return;

    // Bright pass into the first (half-resolution) bloom level.
    const first = this.bloomChain[0]!;
    first.bind();
    this.brightPassProgram.use();
    this.brightPassProgram.setTexture('uSource', 0, this.sceneTarget.texture.handle);
    this.brightPassProgram.setFloat('uThreshold', atmosphere.bloomThreshold);
    this.brightPassProgram.setFloat('uKnee', atmosphere.bloomKnee);
    this.brightPassProgram.setFloat('uIntensity', 1);
    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;

    // Downsample chain.
    for (let i = 1; i < levels; i++) {
      const source = this.bloomChain[i - 1]!;
      const destination = this.bloomChain[i]!;
      destination.bind();
      this.kawaseDownProgram.use();
      this.kawaseDownProgram.setTexture('uSource', 0, source.texture.handle);
      this.kawaseDownProgram.setVec2('uTexelSize', 1 / source.width, 1 / source.height);
      this.fullscreen.draw();
      this.fullscreenPasses++;
    }

    // Upsample chain, accumulating additively so every scale contributes.
    this.device.setBlend(BlendMode.Additive);
    for (let i = levels - 1; i > 0; i--) {
      const source = this.bloomChain[i]!;
      const destination = this.bloomChain[i - 1]!;
      destination.bind();
      this.kawaseUpProgram.use();
      this.kawaseUpProgram.setTexture('uSource', 0, source.texture.handle);
      this.kawaseUpProgram.setVec2('uTexelSize', 1 / source.width, 1 / source.height);
      this.fullscreen.draw();
      this.fullscreenPasses++;
    }
    this.device.setBlend(BlendMode.None);
  }

  private renderComposite(request: FrameRequest): void {
    const { atmosphere } = request;

    this.device.bindFramebuffer(null);
    this.device.setViewport(0, 0, this.displayWidth, this.displayHeight);

    if (this.debugView > 0) {
      this.renderDebugView();
      return;
    }

    const program = this.compositeProgram;
    program.use();
    program.setTexture('uScene', 0, this.sceneTarget.texture.handle);
    program.setTexture('uBloom', 1, this.bloomChain[0]!.texture.handle);
    program.setTexture('uDistortion', 2, this.distortionTarget.texture.handle);
    program.setTexture('uGodRays', 3, this.godRayTarget.texture.handle);
    program.setTexture('uColorGrade', 4, this.gradeLUT.handle);
    program.setTexture('uBlueNoise', 5, this.blueNoise.handle);

    program.setFloat('uBloomIntensity', this.settings.bloomLevels > 0 ? atmosphere.bloomIntensity : 0);
    program.setFloat('uExposure', atmosphere.exposure);
    program.setFloat('uAberration', atmosphere.chromaticAberration);
    program.setFloat('uVignette', atmosphere.vignette);
    program.setFloat('uGrainAmount', atmosphere.grainAmount);
    program.setFloat('uTime', request.timeSeconds);
    program.setVec2('uResolution', this.displayWidth, this.displayHeight);
    program.setFloat('uGradeMix', atmosphere.gradeMix);
    program.setFloat('uBarrel', atmosphere.barrelDistortion);
    program.setFloat('uSaturation', atmosphere.saturation);
    program.setFloat('uContrast', atmosphere.contrast);
    program.setFloat('uLift', atmosphere.lift);

    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;
  }

  /** Renders a single intermediate buffer, for debugging the pipeline. */
  private renderDebugView(): void {
    const views: (Texture | undefined)[] = [
      undefined,
      this.gbuffer.textures[0],
      this.gbuffer.textures[1],
      this.gbuffer.textures[2],
      this.gbuffer.textures[3],
      this.occluder.texture,
      this.lightTarget.texture,
      this.godRayTarget.texture,
      this.bloomChain[0]?.texture,
      this.distortionTarget.texture,
      this.sceneTarget.texture,
    ];
    const texture = views[this.debugView] ?? this.sceneTarget.texture;
    this.copyProgram.use();
    this.copyProgram.setTexture('uSource', 0, texture.handle);
    this.copyProgram.setFloat('uScale', 1);
    this.device.setBlend(BlendMode.None);
    this.fullscreen.draw();
    this.fullscreenPasses++;
  }

  /** Upload a new colour-grading LUT, e.g. on a biome change. */
  setGradeLUT(pixels: Uint8Array): void {
    this.gradeLUT.upload(pixels);
  }

  get blurProgramRef(): Program {
    return this.blurProgram;
  }

  dispose(): void {
    this.pool.disposeAll();
    this.batch.dispose();
    this.fullscreen.dispose();
    this.blueNoise.dispose();
    this.gradeLUT.dispose();
    this.fogNoise.dispose();
    this.spriteProgram.dispose();
    this.occluderProgram.dispose();
    this.lightingProgram.dispose();
    this.brightPassProgram.dispose();
    this.kawaseDownProgram.dispose();
    this.kawaseUpProgram.dispose();
    this.godRayProgram.dispose();
    this.fogProgram.dispose();
    this.compositeProgram.dispose();
    this.copyProgram.dispose();
    this.blurProgram.dispose();
  }
}
