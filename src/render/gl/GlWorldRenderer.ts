/**
 * WebGL2 world renderer (Stage 4: 2D deferred lighting).
 *
 * Replaces the Stage 1/2 "paint with Classic, upload as a texture" hybrid with a real GPU
 * pipeline: a G-buffer geometry pass (textured tiles + coloured entity quads, each writing
 * albedo/normal/material/emissive), a fullscreen deferred lighting pass that combines that
 * G-buffer with a dynamic light list, and a tonemap present pass that resolves the HDR (or LDR,
 * see below) accumulation buffer to the backbuffer. `ClassicWorldRenderer` is kept around purely
 * as an emergency fallback — if anything in the deferred pipeline throws mid-frame, this renderer
 * permanently switches to it rather than crashing the game (see {@link draw}).
 *
 * Pipeline, once per frame:
 *  1. **Geometry pass** — {@link gBuffer} is cleared and filled: {@link tileBatch} draws every
 *     visible tile as a textured quad sampling the shared material atlas; {@link gbufferBatch}
 *     draws every entity (pickups, enemies, projectiles, the player) as a flat-coloured quad with
 *     a procedural bevel normal. No blending: later draws simply overwrite earlier ones, which is
 *     enough painter's-algorithm ordering for a 2D platformer with no overlapping geometry that
 *     needs to blend.
 *  2. **Occluder pass** — {@link occluderTarget} (a single-channel mask) is stamped with a white
 *     quad per visible solid tile and the player's AABB, feeding the lighting pass's soft-shadow
 *     ray march.
 *  3. **Background pass** — {@link backgroundTarget} gets the sky gradient, hi-res "enhanced"
 *     parallax layers (`parallaxEnhanced.ts`), a few cheap analytic volumetric light shafts, and
 *     the atmospheric scrim, unlit. Kept separate from the G-buffer so it is cheap and never needs
 *     a normal/material of its own.
 *  4. **Lighting pass** — {@link lightingPass} combines G-buffer + occluder + background + the
 *     frame's {@link LightList} (from {@link collectLights}) into {@link accumTarget}.
 *  5. **Bloom** (Stage 7, `post/bloom.ts`) — {@link bloomPass} thresholds the emissive G-buffer
 *     channel and adds a soft, dual-Kawase-blurred glow back onto {@link accumTarget}, additively,
 *     before anything else touches it. Skipped entirely under low quality/`settings.bloom`
 *     off/reduced motion.
 *  6. **Forward pass** — dash ghosts, the jetpack flame and particles ({@link particleBatch},
 *     Stage 6's soft-edged instanced batch) are drawn directly into {@link accumTarget} with real
 *     alpha/additive blending (they are all bright, blend-heavy FX that do not need to interact
 *     with the light list).
 *  7. **Composite present** (Stage 7, `post/composite.ts`) — {@link compositePass} tonemaps
 *     {@link accumTarget} (ACES or AgX), optionally layers on a vignette/filmic grain/chromatic
 *     aberration, and always dithers to fight 8-bit banding, resolving to the real backbuffer
 *     (sized to the device, not 480×270 — see {@link resize}). The backbuffer is then blitted into
 *     the game's Canvas2D display surface so HUD/screens/e2e keep working unchanged.
 *
 * Sizing: gameplay coordinates always stay in the fixed 480×270 world-view space ({@link
 * INTERNAL_WIDTH}×{@link INTERNAL_HEIGHT}, matching Classic) — every vertex shader maps world
 * position to clip space through a `u_view` uniform holding that constant, never the target's
 * actual pixel size, so the same draw calls are resolution-independent. Every render target in the
 * list above (G-buffer, occluder, background, accumulation, bloom's mip chain) is instead sized to
 * {@link internalTargetWidth}×{@link internalTargetHeight}, which tracks the real backbuffer
 * (device pixels, set by {@link resize}) — rasterizing the *same* 480×270-unit geometry into a
 * larger framebuffer is simply supersampling: edges and lighting gradients come out anti-aliased
 * for free, instead of the old fixed-480×270-then-GPU-upscale path that made Enhanced look like
 * blown-up pixel art. `internalTargetWidth/Height` can drop below the backbuffer size under
 * sustained GPU load (see {@link updateDynamicResolution}); the final composite pass always
 * fills the full backbuffer regardless, so a throttled frame reads as softer, not smaller.
 *
 * HDR: {@link accumTarget} uses `RGBA16F` when {@link GlCaps.hdrSupported}, so stacked emissives
 * and lights can exceed 1.0 before the tonemap curve compresses them; it falls back to plain
 * `RGBA8` (values simply clamp at 1.0 instead) on hardware without `EXT_color_buffer_float`. The
 * G-buffer itself is always `RGBA8` — it stores material properties and LDR colours, not light.
 */

import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../../core/canvas';
import { clamp } from '../../core/math';
import { INVULNERABLE_BLINK_HZ, PLAYER_HEIGHT, PLAYER_WIDTH, RUN_MAX_SPEED } from '../../game/constants';
import { ENEMY_DEATH_TIME, PROJECTILE_SIZE } from '../../game/enemies';
import type { Enemy } from '../../game/enemies';
import type { Pickup } from '../../game/pickups';
import { isSolid } from '../../game/tiles';
import { TileKind } from '../../game/tiles';
import type { World } from '../../game/world';
import { parseColor } from '../color';
import { generateMaterialAtlas } from '../materials/generate';
import { materialForTileAt } from '../materials/tileMaterial';
import { ALL_MATERIAL_IDS } from '../materials/types';
import type { AtlasRect, MaterialId } from '../materials/types';
import { createParallaxLayers } from '../parallax';
import { palette } from '../palette';
import type { ParticleView } from '../particles';
import { ClassicWorldRenderer } from '../renderer';
import { drawRigToGBuffer } from '../rig/drawRig';
import { buildEnemyRig } from '../rig/enemyRigs';
import { buildOptimusRig } from '../rig/optimusRig';
import { DEFAULT_RENDER_SETTINGS } from '../settings';
import type { QualityPreset, RenderSettings } from '../settings';
import type { WorldView } from '../view';
import { BackgroundBatch } from './backgroundBatch';
import { GlDevice, tryCreateWebGL2 } from './device';
import { GBufferBatch } from './gbufferBatch';
import { GpuTimer } from './gpuTimer';
import { LightList, collectLights } from './lights';
import { LightingPass } from './lightingPass';
import { uploadMaterialAtlas } from './materialTextures';
import type { MaterialTextureSet } from './materialTextures';
import { ParticleBatch, particleBlendGroup } from './particleBatch';
import { BloomPass } from './post/bloom';
import { CompositePass } from './post/composite';
import { RenderTarget } from './renderTarget';
import { SolidBatch } from './solidBatch';
import type { CameraOffset, ViewSize } from './solidBatch';
import { TileBatch } from './tileBatch';
import type { UvRect } from './tileBatch';
import { TonemapPass } from './tonemap';
import type { Texture } from './texture';
import { Filter, TexFormat } from './texture';

/**
 * Soft-threshold cutoff and overall strength for Stage 7's emissive-only bloom (`post/bloom.ts`).
 * Tuned for a Dead Cells-style glow (see `docs/art-direction.md`) — a lower threshold catches more
 * of the emissive channel's mid-brightness detail (goal, visor, light shafts), and a higher
 * intensity makes the resulting halo read as a punchy pickup/beacon glow rather than a faint hint.
 */
const BLOOM_THRESHOLD = 0.14;
const BLOOM_INTENSITY = 1.85;

/** Bound on the internal grain-hash time counter (seconds); wraps so long sessions keep float precision. */
const TIME_WRAP_SEC = 1000;

/**
 * Dynamic-resolution ladder for {@link GlWorldRenderer.updateDynamicResolution}: the fraction of
 * the real backbuffer the deferred pipeline's render targets actually use. Index 0 (no reduction)
 * is preferred; higher indices trade sharpness for GPU headroom under sustained load.
 */
const DYNAMIC_RES_SCALE_STEPS: readonly number[] = [1, 0.85, 0.7, 0.55, 0.45];
/** Sustained GPU frame time (ms) above which dynamic resolution drops a step. */
const DYNAMIC_RES_HIGH_MS = 13;
/** Sustained GPU frame time (ms) below which dynamic resolution recovers a step. */
const DYNAMIC_RES_LOW_MS = 9;
/** Smoothing factor for the GPU-time EMA — small, so single-frame spikes do not trigger a resize. */
const DYNAMIC_RES_EMA_ALPHA = 0.15;
/** Minimum frames between dynamic-resolution steps, so the ladder cannot thrash every frame. */
const DYNAMIC_RES_COOLDOWN_FRAMES = 40;
/**
 * Dynamic resolution only engages once the backbuffer is at least this multiple of the internal
 * world-view's pixel area — a Classic-sized buffer is already cheap enough that throttling it
 * would only cost sharpness for no headroom gained.
 */
const DYNAMIC_RES_MIN_AREA_RATIO = 2;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One dash after-image; drawn as a fading additive quad in the forward pass. */
interface DashGhost {
  readonly x: number;
  readonly y: number;
  age: number;
}

/** Longer Dead Cells-style after-image than Classic's short `drawDashGhost` — denser trail copies. */
const GHOST_LIFETIME = 0.4;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

type DebugChannel = 'albedo' | 'normal' | 'emissive' | 'occluder';

const DEBUG_CHANNELS: readonly DebugChannel[] = ['albedo', 'normal', 'emissive', 'occluder'];

/** Parses the `?gdbg=` query value into a known channel, or `null` for anything else/absent. */
function parseDebugChannel(value: string | null): DebugChannel | null {
  const match = DEBUG_CHANNELS.find((channel) => channel === value);
  return match ?? null;
}

/**
 * Half-texel bleed into each material's wrapped atlas padding (`ATLAS_PADDING` in
 * `materials/generate.ts`). Logical rects already sit inset by that padding; expanding UVs
 * slightly into the border lets bilinear filtering soften Enhanced tile edges without sampling a
 * neighbouring material cell.
 */
const TILE_UV_PAD_BLEED_TEXELS = 0.5;

/**
 * World-space half-overlap when queuing Enhanced tile quads. Adjacent 16px tiles overlap by 1px
 * total so the deferred G-buffer seam blends instead of reading as a hard grid; gameplay
 * collision (`game/`) and Classic Canvas2D tiles are untouched.
 */
const TILE_EDGE_OVERLAP_PX = 0.5;

function uvRectFromAtlasRect(rect: AtlasRect, atlasWidth: number, atlasHeight: number): UvRect {
  const bleed = TILE_UV_PAD_BLEED_TEXELS;
  return {
    u0: (rect.x - bleed) / atlasWidth,
    v0: (rect.y - bleed) / atlasHeight,
    u1: (rect.x + rect.width + bleed) / atlasWidth,
    v1: (rect.y + rect.height + bleed) / atlasHeight,
  };
}

/**
 * Overall brightness multiplier for {@link BackgroundBatch.drawLightShafts}, derived from the
 * quality preset the same way bloom/grain/etc. scale back at lower presets (`settings.lightShafts`
 * and reduced motion are applied on top of this by the caller, see `drawBackgroundPass`).
 */
function lightShaftIntensity(quality: QualityPreset): number {
  switch (quality) {
    case 'low':
      return 0;
    case 'medium':
      return 0.5;
    case 'high':
      return 1.05;
    case 'ultra':
      return 1.2;
    default: {
      const exhaustive: never = quality;
      throw new Error(`Unhandled quality preset in GlWorldRenderer: ${String(exhaustive)}`);
    }
  }
}

/** Per-tile-kind emissive scalar fed into {@link TileBatch.tile}; multiplies the tile's albedo. */
function tileEmissive(kind: TileKind, tx: number, ty: number, world: World): number {
  switch (kind) {
    case TileKind.Goal:
      return 1.15;
    case TileKind.Checkpoint:
      return world.isCheckpointActive(tx, ty) ? 1 : 0.12;
    case TileKind.Empty:
    case TileKind.Solid:
    case TileKind.OneWay:
    case TileKind.Spike:
    case TileKind.ConveyorLeft:
    case TileKind.ConveyorRight:
    case TileKind.Scenery:
      return 0;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind in GlWorldRenderer: ${String(exhaustive)}`);
    }
  }
}

export class GlWorldRenderer implements WorldView {
  readonly backend = 'webgl2';

  private readonly device: GlDevice;
  private readonly canvas: HTMLCanvasElement;
  /** Emergency fallback: used verbatim once {@link glFailed} trips, and kept warm until then. */
  private readonly classic: ClassicWorldRenderer;

  private readonly gBuffer: RenderTarget;
  private readonly gBufferAlbedo: Texture;
  private readonly gBufferNormal: Texture;
  private readonly gBufferMaterial: Texture;
  private readonly gBufferEmissive: Texture;
  private readonly backgroundTarget: RenderTarget;
  private readonly occluderTarget: RenderTarget;
  private readonly accumTarget: RenderTarget;

  private readonly tileBatch: TileBatch;
  private readonly gbufferBatch: GBufferBatch;
  private readonly backgroundBatch: BackgroundBatch;
  /** Dedicated {@link SolidBatch} for stamping the occluder mask (white = "blocks light"). */
  private readonly occluderBatch: SolidBatch;
  /** Dedicated {@link SolidBatch} for post-lighting forward FX (ghosts, flame). */
  private readonly forwardBatch: SolidBatch;
  /** GPU-instanced soft-edged particle batch (Stage 6) — see `post-lighting forward FX` above. */
  private readonly particleBatch: ParticleBatch;
  private readonly lightingPass: LightingPass;
  /** Emissive-only dual-Kawase bloom (Stage 7), composited additively into {@link accumTarget}. */
  private readonly bloomPass: BloomPass;
  /** Tonemap + vignette/grain/chromatic-aberration/dither present (Stage 7); replaces {@link tonemapPass}
   * on the main path — {@link tonemapPass} is kept only for the raw G-buffer debug view. */
  private readonly compositePass: CompositePass;
  private readonly tonemapPass: TonemapPass;
  private readonly gpuTimer: GpuTimer;
  private readonly lights = new LightList();

  private readonly materialTextures: MaterialTextureSet;
  private readonly materialUvRects: ReadonlyMap<MaterialId, UvRect>;

  private disposed = false;
  /** Set once a deferred frame throws; from then on this renderer permanently defers to Classic. */
  private glFailed = false;

  /** Real backbuffer size (device pixels); defaults to the world view until {@link resize}. */
  private backbufferWidth = INTERNAL_WIDTH;
  private backbufferHeight = INTERNAL_HEIGHT;
  /**
   * Actual pixel size of the deferred pipeline's render targets (G-buffer, occluder, background,
   * accumulation, bloom). Tracks {@link backbufferWidth}/{@link backbufferHeight} 1:1 unless
   * {@link updateDynamicResolution} has throttled it back under sustained GPU load.
   */
  private internalTargetWidth = INTERNAL_WIDTH;
  private internalTargetHeight = INTERNAL_HEIGHT;
  /** Current step into {@link DYNAMIC_RES_SCALE_STEPS}; 0 is full resolution. */
  private dynamicResStep = 0;
  /** Frames left before {@link updateDynamicResolution} may change {@link dynamicResStep} again. */
  private dynamicResCooldown = 0;
  /** Exponential moving average of {@link gpuTimer}'s per-frame reading, in milliseconds. */
  private renderMsEma: number | null = null;
  private levelId: string;
  private ghosts: DashGhost[] = [];
  private prevCamera: Point | null = null;
  private currCamera: Point | null = null;
  private prevPlayer: Point | null = null;
  private currPlayer: Point | null = null;
  /** Seconds of simulated time, wrapped every {@link TIME_WRAP_SEC}; seeds the composite pass's grain. */
  private frameTimeSec = 0;

  /**
   * Optional G-buffer channel visualiser, e.g. `?gdbg=normal`. Parsed once at construction (not
   * per frame, to keep the hot path allocation-free) — a debugging aid for this stage, not a user
   * feature, so it deliberately has no UI.
   */
  private readonly debugChannel: 'albedo' | 'normal' | 'emissive' | 'occluder' | null;

  constructor(device: GlDevice, world: World | null) {
    this.device = device;
    const { gl } = device;
    this.canvas = gl.canvas as HTMLCanvasElement;
    this.canvas.width = this.backbufferWidth;
    this.canvas.height = this.backbufferHeight;

    this.classic = new ClassicWorldRenderer(world);

    this.gBuffer = new RenderTarget(gl, [
      { format: TexFormat.RGBA8, clear: [0, 0, 0, 0] }, // albedo; alpha doubles as coverage
      { format: TexFormat.RGBA8, clear: [0.5, 0.5, 1, 1] }, // normal, packed flat "up"
      { format: TexFormat.RGBA8, clear: [0, 1, 0, 1] }, // roughness, ao, metallic
      { format: TexFormat.RGBA8, clear: [0, 0, 0, 1] }, // emissive
    ]);
    this.gBuffer.resize(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    const [albedo, normal, material, emissive] = this.gBuffer.textures;
    if (albedo === undefined || normal === undefined || material === undefined || emissive === undefined) {
      throw new Error('G-buffer render target is missing an attachment.');
    }
    this.gBufferAlbedo = albedo;
    this.gBufferNormal = normal;
    this.gBufferMaterial = material;
    this.gBufferEmissive = emissive;

    this.backgroundTarget = new RenderTarget(gl, [{ format: TexFormat.RGBA8, clear: [0, 0, 0, 1] }]);
    this.backgroundTarget.resize(INTERNAL_WIDTH, INTERNAL_HEIGHT);

    this.occluderTarget = new RenderTarget(gl, [{ format: TexFormat.R8, clear: [0, 0, 0, 0] }]);
    this.occluderTarget.resize(INTERNAL_WIDTH, INTERNAL_HEIGHT);

    // HDR when the device supports rendering to a float colour buffer; otherwise the accumulation
    // target is plain LDR RGBA8 and bright stacked lights simply clamp instead of blowing out.
    const accumFormat = device.caps.hdrSupported ? TexFormat.RGBA16F : TexFormat.RGBA8;
    this.accumTarget = new RenderTarget(gl, [{ format: accumFormat, clear: [0, 0, 0, 1] }]);
    this.accumTarget.resize(INTERNAL_WIDTH, INTERNAL_HEIGHT);

    const materialAtlas = generateMaterialAtlas();
    this.materialTextures = uploadMaterialAtlas(gl, materialAtlas);
    // Enhanced always samples the material atlas with linear filtering, regardless of
    // supersampling ratio — smooth-shaded HD-2D materials, not Classic's crisp nearest-neighbour
    // pixel look (see `docs/art-direction.md`). Atlas tiles are padded with a wrapped border
    // (`materials/generate.ts`); UV rects bleed slightly into that padding (see
    // `uvRectFromAtlasRect`) so linear sampling softens tile edges without bleeding one material
    // into its neighbour. Classic (`ClassicWorldRenderer`) is a separate Canvas2D painter untouched
    // by this and stays nearest-only.
    this.materialTextures.setFilter(Filter.Linear);
    const uvRects = new Map<MaterialId, UvRect>();
    for (const id of ALL_MATERIAL_IDS) {
      uvRects.set(id, uvRectFromAtlasRect(materialAtlas.layout.rects[id], materialAtlas.layout.width, materialAtlas.layout.height));
    }
    this.materialUvRects = uvRects;

    this.tileBatch = new TileBatch(gl, this.materialTextures);
    this.gbufferBatch = new GBufferBatch(gl);
    this.backgroundBatch = new BackgroundBatch(gl);
    this.occluderBatch = new SolidBatch(gl);
    this.forwardBatch = new SolidBatch(gl);
    this.particleBatch = new ParticleBatch(gl);
    this.lightingPass = new LightingPass(gl);
    this.bloomPass = new BloomPass(gl, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    this.compositePass = new CompositePass(gl);
    this.tonemapPass = new TonemapPass(gl);
    this.gpuTimer = new GpuTimer(gl);

    this.levelId = world?.level.id ?? '';
    if (world !== null) {
      this.backgroundBatch.setLayers(
        createParallaxLayers({
          seed: world.level.seed,
          viewWidth: INTERNAL_WIDTH,
          viewHeight: INTERNAL_HEIGHT,
          quality: 'enhanced',
        }),
      );
    }

    this.debugChannel = parseDebugChannel(
      typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('gdbg'),
    );
  }

  /** Approximate GPU time for the last completed frame, or `null` before the first result lands. */
  get lastGpuMs(): number | null {
    return this.gpuTimer.lastMs;
  }

  trackTrail(world: World, dtSec: number): void {
    // Kept warm even while the deferred pipeline is healthy, so a mid-session `glFailed` fallback
    // does not resume Classic with a stale/empty ghost trail.
    this.classic.trackTrail(world, dtSec);

    this.frameTimeSec = (this.frameTimeSec + dtSec) % TIME_WRAP_SEC;

    const { player } = world;
    if (player.state === 'dash') {
      const px = player.body.x;
      const py = player.body.y;
      // Dense trail: current pose plus a soft mid-copy toward the previous sample so the streak
      // reads continuous even when the sim ticks below the display refresh.
      this.ghosts.push({ x: px, y: py, age: 0 });
      if (this.currPlayer !== null) {
        this.ghosts.push({
          x: (px + this.currPlayer.x) * 0.5,
          y: (py + this.currPlayer.y) * 0.5,
          age: GHOST_LIFETIME * 0.06,
        });
      }
    }
    for (const ghost of this.ghosts) ghost.age += dtSec;
    this.ghosts = this.ghosts.filter((ghost) => ghost.age < GHOST_LIFETIME);

    this.prevCamera = this.currCamera ?? { x: world.camera.renderX, y: world.camera.renderY };
    this.currCamera = { x: world.camera.renderX, y: world.camera.renderY };
    this.prevPlayer = this.currPlayer ?? { x: player.body.x, y: player.body.y };
    this.currPlayer = { x: player.body.x, y: player.body.y };
  }

  /**
   * Resize the GL backbuffer to match the display's real buffer (device pixels). The deferred
   * pipeline's render targets follow suit (see {@link applyInternalTargetSize}) — world-view
   * coordinates ({@link INTERNAL_WIDTH}×{@link INTERNAL_HEIGHT}, fed to every `u_view` uniform)
   * never change, so this simply supersamples the same draw calls into a bigger framebuffer.
   */
  resize(bufferWidth: number, bufferHeight: number): void {
    const width = Math.max(1, Math.round(bufferWidth));
    const height = Math.max(1, Math.round(bufferHeight));
    if (width === this.backbufferWidth && height === this.backbufferHeight) return;
    this.backbufferWidth = width;
    this.backbufferHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
    // A real backbuffer resize invalidates any throttling decision made for the old size — start
    // back at full resolution and let updateDynamicResolution re-derive a step for the new size.
    this.dynamicResStep = 0;
    this.dynamicResCooldown = 0;
    this.renderMsEma = null;
    this.applyInternalTargetSize();
  }

  /**
   * Recompute {@link internalTargetWidth}/{@link internalTargetHeight} from
   * {@link backbufferWidth}/{@link backbufferHeight} and {@link dynamicResStep}, and — only if
   * that actually changed — reallocate every deferred render target (G-buffer, occluder,
   * background, accumulation, bloom's mip chain) at the new size. No-op otherwise, so this is
   * safe to call every frame without thrashing GPU memory.
   */
  private applyInternalTargetSize(): void {
    const scale = DYNAMIC_RES_SCALE_STEPS[this.dynamicResStep] ?? 1;
    const width = Math.max(1, Math.round(this.backbufferWidth * scale));
    const height = Math.max(1, Math.round(this.backbufferHeight * scale));
    if (width === this.internalTargetWidth && height === this.internalTargetHeight) return;
    this.internalTargetWidth = width;
    this.internalTargetHeight = height;
    this.gBuffer.resize(width, height);
    this.backgroundTarget.resize(width, height);
    this.occluderTarget.resize(width, height);
    this.accumTarget.resize(width, height);
    this.bloomPass.resize(width, height);
  }

  /**
   * Discrete-step, hysteresis-guarded dynamic resolution: smooths {@link gpuTimer}'s per-frame
   * reading into {@link renderMsEma}, and — after {@link DYNAMIC_RES_COOLDOWN_FRAMES} frames of
   * headroom to avoid thrashing — drops a step (see {@link DYNAMIC_RES_SCALE_STEPS}) under
   * sustained GPU load or recovers one once load eases. Only engages when
   * `settings.dynamicResolution` is on and the backbuffer is large enough that throttling it
   * actually buys back meaningful GPU time (see {@link DYNAMIC_RES_MIN_AREA_RATIO}); otherwise
   * this always resets back to full resolution.
   */
  private updateDynamicResolution(settings: RenderSettings): void {
    const backbufferArea = this.backbufferWidth * this.backbufferHeight;
    const worldViewArea = INTERNAL_WIDTH * INTERNAL_HEIGHT;
    const eligible = settings.dynamicResolution && backbufferArea >= worldViewArea * DYNAMIC_RES_MIN_AREA_RATIO;
    if (!eligible) {
      this.renderMsEma = null;
      this.dynamicResCooldown = 0;
      if (this.dynamicResStep !== 0) {
        this.dynamicResStep = 0;
        this.applyInternalTargetSize();
      }
      return;
    }

    const sample = this.gpuTimer.lastMs;
    if (sample !== null) {
      this.renderMsEma = this.renderMsEma === null ? sample : lerp(this.renderMsEma, sample, DYNAMIC_RES_EMA_ALPHA);
    }

    if (this.dynamicResCooldown > 0) {
      this.dynamicResCooldown -= 1;
      return;
    }
    if (this.renderMsEma === null) return;

    const maxStep = DYNAMIC_RES_SCALE_STEPS.length - 1;
    if (this.renderMsEma > DYNAMIC_RES_HIGH_MS && this.dynamicResStep < maxStep) {
      this.dynamicResStep += 1;
      this.dynamicResCooldown = DYNAMIC_RES_COOLDOWN_FRAMES;
      this.applyInternalTargetSize();
    } else if (this.renderMsEma < DYNAMIC_RES_LOW_MS && this.dynamicResStep > 0) {
      this.dynamicResStep -= 1;
      this.dynamicResCooldown = DYNAMIC_RES_COOLDOWN_FRAMES;
      this.applyInternalTargetSize();
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    world: World,
    alpha?: number,
    settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
    reducedMotion = false,
  ): void {
    if (this.disposed || this.device.isLost || this.glFailed) {
      this.classic.draw(ctx, world, alpha);
      return;
    }
    try {
      this.drawDeferred(ctx, world, alpha, settings, reducedMotion);
    } catch (error) {
      // A broken frame must not crash the game: fall back to the Classic hybrid permanently (see
      // the module doc's "graceful fallback" contract) rather than retrying a pipeline that just
      // proved it cannot render this device/world combination.
      console.error('[GlWorldRenderer] Deferred pipeline failed; falling back to Classic.', error);
      this.glFailed = true;
      this.classic.draw(ctx, world, alpha);
    }
  }

  drawDebug(ctx: CanvasRenderingContext2D, world: World): void {
    this.classic.drawDebug(ctx, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gBuffer.dispose();
    this.backgroundTarget.dispose();
    this.occluderTarget.dispose();
    this.accumTarget.dispose();
    this.materialTextures.dispose();
    this.tileBatch.dispose();
    this.gbufferBatch.dispose();
    this.backgroundBatch.dispose();
    this.occluderBatch.dispose();
    this.forwardBatch.dispose();
    this.particleBatch.dispose();
    this.lightingPass.dispose();
    this.bloomPass.dispose();
    this.compositePass.dispose();
    this.tonemapPass.dispose();
    this.gpuTimer.dispose();
    this.device.dispose();
  }

  /** Rebuild level-scoped GPU state (parallax layers, ghost/camera history) on a level change. */
  private ensureLevel(world: World): void {
    if (world.level.id === this.levelId) return;
    this.levelId = world.level.id;
    this.ghosts = [];
    this.prevCamera = null;
    this.currCamera = null;
    this.prevPlayer = null;
    this.currPlayer = null;
    this.backgroundBatch.setLayers(
      createParallaxLayers({
        seed: world.level.seed,
        viewWidth: INTERNAL_WIDTH,
        viewHeight: INTERNAL_HEIGHT,
        quality: 'enhanced',
      }),
    );
  }

  private interpolatedCamera(world: World, alpha: number | undefined): Point {
    if (alpha === undefined || alpha <= 0 || this.prevCamera === null || this.currCamera === null) {
      return { x: world.camera.renderX, y: world.camera.renderY };
    }
    return {
      x: lerp(this.prevCamera.x, this.currCamera.x, alpha),
      y: lerp(this.prevCamera.y, this.currCamera.y, alpha),
    };
  }

  private interpolatedPlayer(world: World, alpha: number | undefined): Point {
    if (alpha === undefined || alpha <= 0 || this.prevPlayer === null || this.currPlayer === null) {
      return { x: world.player.body.x, y: world.player.body.y };
    }
    return {
      x: lerp(this.prevPlayer.x, this.currPlayer.x, alpha),
      y: lerp(this.prevPlayer.y, this.currPlayer.y, alpha),
    };
  }

  private drawDeferred(
    ctx: CanvasRenderingContext2D,
    world: World,
    alpha: number | undefined,
    settings: RenderSettings,
    reducedMotion: boolean,
  ): void {
    const { gl } = this.device;
    this.ensureLevel(world);
    // Reacts to *last* frame's resolved GPU time (see GpuTimer's read-back latency), so any step
    // change here takes effect on this frame's own render targets before anything draws into them.
    this.updateDynamicResolution(settings);

    const view: ViewSize = { width: INTERNAL_WIDTH, height: INTERNAL_HEIGHT };
    const cam: CameraOffset = this.interpolatedCamera(world, alpha);
    const player = this.interpolatedPlayer(world, alpha);

    this.gpuTimer.begin();

    this.drawGeometryPass(world, view, cam, player);
    this.drawOccluderPass(world, view, cam, player);
    this.drawBackgroundPass(view, cam, settings, reducedMotion);

    // Debugging aid (`?gdbg=albedo|normal|emissive|occluder`): short-circuit before the lighting
    // pass and present a raw G-buffer/occluder channel instead of the lit scene.
    if (this.debugChannel !== null) {
      const target = this.debugChannelTexture(this.debugChannel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.backbufferWidth, this.backbufferHeight);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tonemapPass.draw(target.handle, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.canvas, 0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
      this.gpuTimer.end();
      return;
    }

    collectLights(
      {
        world,
        settings,
        reducedMotion,
        cameraX: cam.x,
        cameraY: cam.y,
        viewWidth: view.width,
        viewHeight: view.height,
      },
      this.lights,
    );

    // Low quality trades shadows for headroom; every other preset honours `settings.shadows`.
    const shadowsEnabled = settings.shadows && settings.quality !== 'low';
    this.accumTarget.bindAndClear();
    gl.disable(gl.BLEND);
    this.lightingPass.draw({
      albedo: this.gBufferAlbedo,
      normal: this.gBufferNormal,
      material: this.gBufferMaterial,
      emissive: this.gBufferEmissive,
      occluder: this.occluderTarget.texture,
      background: this.backgroundTarget.texture,
      view,
      camera: cam,
      lights: this.lights,
      shadowsEnabled,
    });

    // Quality low always skips bloom (headroom over correctness); reduced motion forces every
    // Stage 7 screen-space effect off regardless of what `settings` itself says (belt-and-braces —
    // `settings` is normally already resolved through `withReducedMotion` by the caller, see
    // `src/main.ts`, but the deferred pipeline does not rely on that having happened).
    if (settings.bloom && settings.quality !== 'low' && !reducedMotion) {
      this.bloomPass.draw({
        emissive: this.gBufferEmissive,
        threshold: BLOOM_THRESHOLD,
        intensity: BLOOM_INTENSITY,
        compositeInto: this.accumTarget,
      });
    }

    this.drawForwardEffects(world, view, cam);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.backbufferWidth, this.backbufferHeight);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.compositePass.draw(this.accumTarget.texture.handle, {
      tonemap: settings.tonemap,
      vignette: settings.vignette && !reducedMotion,
      grain: settings.grain && settings.quality !== 'low' && !reducedMotion,
      chromaticAberration: settings.chromaticAberration && settings.quality !== 'low' && !reducedMotion,
      timeSec: this.frameTimeSec,
    });

    this.gpuTimer.end();

    // Present into the game's Canvas2D display surface so HUD/screens/e2e keep working unchanged.
    // Destination size is given in world-view units, not backbuffer pixels: an Enhanced display
    // applies its own transform so this lands at the real (larger) buffer resolution untouched.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
  }

  private drawGeometryPass(world: World, view: ViewSize, cam: CameraOffset, player: Point): void {
    const { gl } = this.device;
    this.gBuffer.bindAndClear();
    gl.disable(gl.BLEND);

    this.tileBatch.begin(view, cam);
    this.drawTiles(world, cam, view);
    this.tileBatch.flush();

    this.gbufferBatch.begin(view, cam);
    this.drawPickups(world);
    this.drawEnemies(world);
    this.drawProjectiles(world);
    this.drawPlayer(world, player);
    this.gbufferBatch.flush();
  }

  /** Resolves a {@link DebugChannel} to the texture it should present. */
  private debugChannelTexture(channel: DebugChannel): Texture {
    switch (channel) {
      case 'albedo':
        return this.gBufferAlbedo;
      case 'normal':
        return this.gBufferNormal;
      case 'emissive':
        return this.gBufferEmissive;
      case 'occluder':
        return this.occluderTarget.texture;
      default: {
        const exhaustive: never = channel;
        throw new Error(`Unhandled debug channel: ${String(exhaustive)}`);
      }
    }
  }

  private drawTiles(world: World, cam: CameraOffset, view: ViewSize): void {
    const { map } = world;
    const tileSize = map.tileSize;
    const minTx = Math.max(0, Math.floor(cam.x / tileSize));
    const maxTx = Math.min(map.width - 1, Math.floor((cam.x + view.width) / tileSize));
    const minTy = Math.max(0, Math.floor(cam.y / tileSize));
    const maxTy = Math.min(map.height - 1, Math.floor((cam.y + view.height) / tileSize));

    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        const kind = map.tileAt(tx, ty);
        if (kind === TileKind.Empty) continue;
        const material = materialForTileAt(kind, tx, ty);
        const uv = this.materialUvRects.get(material);
        if (uv === undefined) continue;
        const emissive = tileEmissive(kind, tx, ty, world);
        // Slightly oversized quads + UV bleed into atlas padding (see uvRectFromAtlasRect) soften
        // the visible 16px grid under linear-filtered Enhanced sampling. Classic stays exact.
        const overlap = TILE_EDGE_OVERLAP_PX;
        this.tileBatch.tile(
          tx * tileSize - overlap,
          ty * tileSize - overlap,
          tileSize + overlap * 2,
          tileSize + overlap * 2,
          uv,
          emissive,
        );
      }
    }
  }

  private drawPickups(world: World): void {
    for (const pickup of world.pickups) {
      if (pickup.collected) continue;
      this.drawPickup(pickup, world.pickupOffset(pickup));
    }
  }

  private drawPickup(pickup: Pickup, bob: number): void {
    const x = pickup.x;
    const y = pickup.y + bob;
    switch (pickup.kind) {
      case 'energyCell': {
        const body = parseColor(palette.plateDark);
        const glow = parseColor(palette.energy);
        this.gbufferBatch.rect(x, y, pickup.width, pickup.height, {
          r: body[0],
          g: body[1],
          b: body[2],
          emissiveR: glow[0] * 0.5,
          emissiveG: glow[1] * 0.5,
          emissiveB: glow[2] * 0.5,
          roughness: 0.4,
          metallic: 0.5,
        });
        break;
      }
      case 'bolt': {
        const c = parseColor(palette.plateLight);
        this.gbufferBatch.rect(x, y, pickup.width, pickup.height, {
          r: c[0],
          g: c[1],
          b: c[2],
          roughness: 0.3,
          metallic: 0.85,
        });
        break;
      }
      case 'repairKit': {
        const c = parseColor(palette.shellLight);
        const cross = parseColor(palette.health);
        this.gbufferBatch.rect(x, y, pickup.width, pickup.height, {
          r: c[0],
          g: c[1],
          b: c[2],
          emissiveR: cross[0] * 0.2,
          emissiveG: cross[1] * 0.2,
          emissiveB: cross[2] * 0.2,
          roughness: 0.6,
          metallic: 0.05,
        });
        break;
      }
      default: {
        const exhaustive: never = pickup.kind;
        throw new Error(`Unhandled pickup kind in GlWorldRenderer: ${String(exhaustive)}`);
      }
    }
  }

  private drawEnemies(world: World): void {
    for (const enemy of world.enemies) {
      if (enemy.state === 'dead') continue;
      this.drawEnemy(world, enemy);
    }
  }

  /**
   * Draws one enemy through {@link buildEnemyRig} — a higher-density silhouette (tread flex,
   * rotor bank, recoil/heat, core iris) than the single flat AABB quad this used to emit.
   */
  private drawEnemy(world: World, enemy: Enemy): void {
    const dyingProgress = enemy.state === 'dying' ? 1 - enemy.deathTimer / ENEMY_DEATH_TIME : 0;
    if (dyingProgress >= 1) return;

    const telegraphing = world.isCrusherTelegraphing(enemy);
    const { x, y, width, height } = enemy.body;

    const parts = buildEnemyRig({
      kind: enemy.kind,
      x,
      y,
      width,
      height,
      facing: enemy.direction,
      animTime: enemy.animTime,
      dying: dyingProgress,
      telegraph: telegraphing || enemy.lethal,
      vulnerable: enemy.kind === 'overseer' ? world.isBossVulnerable(enemy) : false,
      hitPoints: enemy.hitPoints,
    });
    drawRigToGBuffer(this.gbufferBatch, parts);
  }

  private drawProjectiles(world: World): void {
    const body = parseColor(palette.hazardDark);
    const glow = parseColor(palette.hazard);
    for (const projectile of world.projectiles.all) {
      if (!projectile.active) continue;
      this.gbufferBatch.rect(
        projectile.x - PROJECTILE_SIZE / 2,
        projectile.y - PROJECTILE_SIZE / 2,
        PROJECTILE_SIZE,
        PROJECTILE_SIZE,
        {
          r: body[0],
          g: body[1],
          b: body[2],
          emissiveR: glow[0] * 0.7,
          emissiveG: glow[1] * 0.7,
          emissiveB: glow[2] * 0.7,
          roughness: 0.3,
          metallic: 0.7,
        },
      );
    }
  }

  /** Draws Optimus through {@link buildOptimusRig} — the same skeletal rig used to feed the GL path. */
  private drawPlayer(world: World, playerPos: Point): void {
    const { player } = world;
    const blinkedOut =
      player.isInvulnerable && Math.floor(player.invulnerableTime * INVULNERABLE_BLINK_HZ) % 2 === 1;
    if (blinkedOut) return;

    // Soft contact shadow under the feet — a Dead Cells silhouette cue that anchors the character
    // to the ground plane without a full shadow map for the player.
    this.gbufferBatch.rect(playerPos.x - 1, playerPos.y + PLAYER_HEIGHT - 1, PLAYER_WIDTH + 2, 3, {
      r: 0.02,
      g: 0.03,
      b: 0.05,
      a: 0.35,
      roughness: 1,
      metallic: 0,
    });

    const parts = buildOptimusRig({
      x: playerPos.x,
      y: playerPos.y,
      facing: player.facing,
      state: player.state,
      animTime: player.animTime,
      speedRatio: Math.abs(player.body.vx) / RUN_MAX_SPEED,
      energyRatio: player.energyRatio,
    });
    drawRigToGBuffer(this.gbufferBatch, parts);
  }

  /** Fills {@link occluderTarget}: solid terrain plus the player's own AABB block light. */
  private drawOccluderPass(world: World, view: ViewSize, cam: CameraOffset, player: Point): void {
    const { gl } = this.device;
    this.occluderTarget.bindAndClear();
    gl.disable(gl.BLEND);
    this.occluderBatch.begin(view, cam);

    const { map } = world;
    const tileSize = map.tileSize;
    const minTx = Math.max(0, Math.floor(cam.x / tileSize));
    const maxTx = Math.min(map.width - 1, Math.floor((cam.x + view.width) / tileSize));
    const minTy = Math.max(0, Math.floor(cam.y / tileSize));
    const maxTy = Math.min(map.height - 1, Math.floor((cam.y + view.height) / tileSize));
    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        if (!isSolid(map.tileAt(tx, ty))) continue;
        this.occluderBatch.rect(tx * tileSize, ty * tileSize, tileSize, tileSize, 1, 1, 1, 1);
      }
    }
    this.occluderBatch.rect(player.x, player.y, PLAYER_WIDTH, PLAYER_HEIGHT, 1, 1, 1, 1);
    this.occluderBatch.flush();
  }

  /**
   * Fills {@link backgroundTarget}: sky gradient, parallax layers, volumetric light shafts and
   * atmospheric scrim. Unlit.
   */
  private drawBackgroundPass(view: ViewSize, cam: CameraOffset, settings: RenderSettings, reducedMotion: boolean): void {
    const { gl } = this.device;
    this.backgroundTarget.bind();
    gl.disable(gl.BLEND);

    const top = parseColor(palette.skyTop);
    const mid = parseColor(palette.skyBottom);
    const bottom = parseColor(palette.fog);
    this.backgroundBatch.drawSky(
      [top[0], top[1], top[2]],
      [mid[0], mid[1], mid[2]],
      [bottom[0], bottom[1], bottom[2]],
    );
    this.backgroundBatch.drawLayers(view.width, view.height, cam.x, cam.y);
    const scrim = parseColor('rgb(9 12 20 / 0.45)');
    this.backgroundBatch.drawScrim(view.width, view.height, scrim[0], scrim[1], scrim[2], scrim[3]);

    const shaftIntensity = reducedMotion ? 0 : lightShaftIntensity(settings.quality) * (settings.lightShafts ? 1 : 0);
    const cool = parseColor(palette.visor);
    const warm = parseColor(palette.flame);
    this.backgroundBatch.drawLightShafts([cool[0], cool[1], cool[2]], [warm[0], warm[1], warm[2]], shaftIntensity, this.frameTimeSec);
  }

  /** Post-lighting forward FX drawn straight into {@link accumTarget}: ghosts, flame, particles. */
  private drawForwardEffects(world: World, view: ViewSize, cam: CameraOffset): void {
    const { gl } = this.device;
    gl.enable(gl.BLEND);

    // Dash ghosts + jetpack flame are additive, matching Classic's `globalCompositeOperation =
    // 'lighter'` ghost trail and its bright, self-illuminated flame sprite.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this.forwardBatch.begin(view, cam);
    this.drawGhosts();
    this.drawJetpackFlame(world);
    this.forwardBatch.flush();

    // Particles: glow-like kinds (sparks, exhaust) additive, everything else plain alpha — see
    // `particleBlendGroup`. Two passes over the (small, ≤512-particle) pool is cheap; each pass is
    // still exactly one instanced draw call via `ParticleBatch`.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this.particleBatch.begin(view, cam);
    this.drawParticles(world, 'additive');
    this.particleBatch.flush();

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.particleBatch.begin(view, cam);
    this.drawParticles(world, 'alpha');
    this.particleBatch.flush();

    gl.disable(gl.BLEND);
  }

  private drawGhosts(): void {
    if (this.ghosts.length === 0) return;
    const outer = parseColor(palette.visorGlow);
    const mid = parseColor(palette.visor);
    const core = parseColor(palette.white);
    for (const ghost of this.ghosts) {
      const life = 1 - ghost.age / GHOST_LIFETIME;
      // Soft cubic fade keeps older trail copies readable without a harsh cutoff.
      const alpha = 0.48 * life * life * life;
      if (alpha <= 0.02) continue;
      // Multi-layer cyan streak: wide soft halo → mid body → hot core (Dead Cells dash juice).
      this.forwardBatch.rect(
        ghost.x - 2.5,
        ghost.y - 2,
        PLAYER_WIDTH + 5,
        PLAYER_HEIGHT + 4,
        outer[0],
        outer[1],
        outer[2],
        alpha * 0.28,
      );
      this.forwardBatch.rect(
        ghost.x - 1,
        ghost.y - 1,
        PLAYER_WIDTH + 2,
        PLAYER_HEIGHT + 2,
        mid[0],
        mid[1],
        mid[2],
        alpha * 0.55,
      );
      this.forwardBatch.rect(ghost.x, ghost.y, PLAYER_WIDTH, PLAYER_HEIGHT, mid[0], mid[1], mid[2], alpha * 0.85);
      this.forwardBatch.rect(
        ghost.x + 2,
        ghost.y + 3,
        PLAYER_WIDTH - 4,
        PLAYER_HEIGHT - 6,
        core[0],
        core[1],
        core[2],
        alpha * 0.35,
      );
    }
  }

  private drawJetpackFlame(world: World): void {
    const { player } = world;
    if (!player.isAlive || player.state !== 'thrust') return;
    const flame = parseColor(palette.flame);
    const hot = parseColor(palette.flameHot);
    const spark = parseColor(palette.spark);
    const flicker = 0.6 + Math.abs(Math.sin(player.animTime * 30)) * 0.4;
    const side = Math.sin(player.animTime * 42) * 0.8;
    const length = (7 + flicker * 7) * clamp(0.35 + player.energyRatio, 0.35, 1);
    const centerX = player.body.x + PLAYER_WIDTH / 2;
    const topY = player.body.y + PLAYER_HEIGHT;
    // Punchy multi-layer plume: outer haze → warm body → hot core → white tip + side wisps.
    this.forwardBatch.rect(centerX - 5.5, topY, 11, length * 0.75, flame[0], flame[1], flame[2], 0.28);
    this.forwardBatch.rect(centerX - 4, topY, 8, length, flame[0], flame[1], flame[2], 0.62);
    this.forwardBatch.rect(centerX - 2.5, topY, 5, length * 0.9, hot[0], hot[1], hot[2], 0.95);
    this.forwardBatch.rect(centerX - 1.2, topY, 2.4, length * 1.2, spark[0], spark[1], spark[2], 1);
    this.forwardBatch.rect(centerX - 0.6, topY + length * 0.15, 1.2, length * 0.55, hot[0], hot[1], hot[2], 0.85);
    this.forwardBatch.rect(centerX - 3.5 + side, topY + length * 0.2, 2, length * 0.45, flame[0], flame[1], flame[2], 0.4);
    this.forwardBatch.rect(centerX + 1.5 - side, topY + length * 0.25, 2, length * 0.4, flame[0], flame[1], flame[2], 0.35);
  }

  /**
   * Approximates `ParticleSystem.draw`'s per-kind sizing/alpha through {@link ParticleBatch}'s
   * soft-edged instanced quads instead of flat rects — `ring` gets a real soft annulus rather than
   * a filled square. Only queues particles whose {@link particleBlendGroup} matches `group`, so
   * `drawForwardEffects` can flush additive and alpha kinds as two separate batches/blend states.
   */
  private drawParticles(world: World, group: 'additive' | 'alpha'): void {
    const { particles } = world;
    for (let i = 0; i < particles.capacity; i += 1) {
      const particle: ParticleView | null = particles.particleAt(i);
      if (particle === null || particleBlendGroup(particle.kind) !== group) continue;
      const progress = clamp(particle.life / particle.maxLife, 0, 1);
      const color = parseColor(particle.color);
      switch (particle.kind) {
        case 'spark':
        case 'debris': {
          // Larger/brighter soft quads so additive sparks read as glowing motes (Dead Cells juice),
          // not 1px flecks once the deferred target is supersampled.
          const size = Math.max(1.85, particle.size * progress * 1.65 + 0.85);
          const alpha = clamp(progress * 1.9, 0, 1);
          this.particleBatch.particle(
            particle.x - size * 0.2,
            particle.y - size * 0.2,
            size,
            size,
            color[0],
            color[1],
            color[2],
            alpha,
          );
          break;
        }
        case 'dust':
        case 'exhaust': {
          const size = Math.max(1.85, particle.size + (1 - progress) * 3.4);
          this.particleBatch.particle(
            particle.x - size / 2,
            particle.y - size / 2,
            size,
            size,
            color[0],
            color[1],
            color[2],
            progress * (particle.kind === 'exhaust' ? 0.95 : 0.6),
          );
          break;
        }
        case 'pickup': {
          const height = Math.max(1.75, 1.75 + progress * 3);
          this.particleBatch.particle(particle.x - 0.65, particle.y, 2.4, height, color[0], color[1], color[2], progress);
          break;
        }
        case 'ring': {
          const radius = Math.max(0.95, (1 - progress) * particle.size * 11);
          this.particleBatch.particle(
            particle.x - radius,
            particle.y - radius,
            radius * 2,
            radius * 2,
            color[0],
            color[1],
            color[2],
            progress * 0.95,
            'ring',
          );
          break;
        }
        default: {
          const exhaustive: never = particle.kind;
          throw new Error(`Unhandled particle kind in GlWorldRenderer: ${String(exhaustive)}`);
        }
      }
    }
  }
}

/**
 * Try to stand up a {@link GlWorldRenderer}.
 *
 * Returns `null` when WebGL2 is unavailable or initialisation throws, so the factory can fall
 * back to Classic without the game failing to boot.
 */
export function tryCreateGlWorldRenderer(world: World | null): WorldView | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = INTERNAL_WIDTH;
    canvas.height = INTERNAL_HEIGHT;
    const gl = tryCreateWebGL2(canvas);
    if (gl === null) return null;
    const device = new GlDevice(gl);
    return new GlWorldRenderer(device, world);
  } catch {
    return null;
  }
}
