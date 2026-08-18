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
 *     visible tile as a textured quad sampling the shared material atlas; {@link spriteBatch}
 *     draws the player and enemies from procedurally baked hand-drawn-style sprite sheets;
 *     {@link gbufferBatch} draws pickups/projectiles (and the player contact shadow) as coloured
 *     quads with a procedural bevel normal. No blending: later draws simply overwrite earlier ones,
 *     which is enough painter's-algorithm ordering for a 2D platformer with no overlapping geometry
 *     that needs to blend.
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
import { INVULNERABLE_BLINK_HZ, PLAYER_HEIGHT, PLAYER_WIDTH } from '../../game/constants';
import { ENEMY_DEATH_TIME, PROJECTILE_SIZE, TURRET_WINDUP } from '../../game/enemies';
import type { Enemy } from '../../game/enemies';
import type { Pickup } from '../../game/pickups';
import { isSolid } from '../../game/tiles';
import { TileKind } from '../../game/tiles';
import type { World } from '../../game/world';
import { parseColor } from '../color';
import { generateMaterialAtlas } from '../materials/generate';
import { materialForTileAt, tileVariation } from '../materials/tileMaterial';
import { ALL_MATERIAL_IDS } from '../materials/types';
import type { AtlasRect, MaterialId } from '../materials/types';
import { createParallaxLayers } from '../parallax';
import { palette } from '../palette';
import type { ParticleView } from '../particles';
import { ClassicWorldRenderer } from '../renderer';
import { DEFAULT_RENDER_SETTINGS } from '../settings';
import type { QualityPreset, RenderSettings } from '../settings';
import {
  buildCharacterAtlas,
  dyingClipAnimTime,
  enemyCanonicalSize,
  enemyClipId,
  ENEMY_VISUAL_SCALE,
  frameKey,
  optimusClipId,
  sampleClipFrame,
  WORLD_DRAW_HEIGHT,
  WORLD_DRAW_WIDTH,
} from '../spritesheet';
import type { CharacterAtlas, ClipId } from '../spritesheet';
import type { WorldView } from '../view';
import { BackgroundBatch } from './backgroundBatch';
import { uploadCharacterAtlas } from './characterTextures';
import type { CharacterTextureSet } from './characterTextures';
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
import { SpriteGBufferBatch } from './spriteGBufferBatch';
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
/** Half-texel bleed into character-sheet cell padding for linear filtering. */
const SPRITE_UV_PAD_BLEED_TEXELS = 0.5;

/**
 * World-space half-overlap when queuing Enhanced tile quads. Adjacent 16px tiles overlap by 1px
 * total so the deferred G-buffer seam blends instead of reading as a hard grid; gameplay
 * collision (`game/`) and Classic Canvas2D tiles are untouched.
 */
const TILE_EDGE_OVERLAP_PX = 1.25;

function uvRectFromAtlasRect(rect: AtlasRect, atlasWidth: number, atlasHeight: number): UvRect {
  const bleed = TILE_UV_PAD_BLEED_TEXELS;
  return {
    u0: (rect.x - bleed) / atlasWidth,
    v0: (rect.y - bleed) / atlasHeight,
    u1: (rect.x + rect.width + bleed) / atlasWidth,
    v1: (rect.y + rect.height + bleed) / atlasHeight,
  };
}

function spriteUvFromRect(
  rect: AtlasRect,
  atlasWidth: number,
  atlasHeight: number,
  facing: number,
): UvRect {
  const bleed = SPRITE_UV_PAD_BLEED_TEXELS;
  const u0 = (rect.x - bleed) / atlasWidth;
  const v0 = (rect.y - bleed) / atlasHeight;
  const u1 = (rect.x + rect.width + bleed) / atlasWidth;
  const v1 = (rect.y + rect.height + bleed) / atlasHeight;
  if (facing < 0) {
    return { u0: u1, v0, u1: u0, v1 };
  }
  return { u0, v0, u1, v1 };
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

/** Combat telegraph for Enhanced sheet selection (crushers/boss + turret wind-up). */
function isEnhancedEnemyTelegraphing(world: World, enemy: Enemy): boolean {
  if (world.isCrusherTelegraphing(enemy) || enemy.lethal) return true;
  if (enemy.kind === 'turret' && enemy.timer > 0 && enemy.timer < TURRET_WINDUP) return true;
  return false;
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
  /** Textured character sheets (hand-drawn-style bake from skeletal rigs). */
  private readonly spriteBatch: SpriteGBufferBatch;
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
  private readonly characterAtlas: CharacterAtlas;
  private readonly characterTextures: CharacterTextureSet;

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
    this.characterAtlas = buildCharacterAtlas();
    this.characterTextures = uploadCharacterAtlas(gl, this.characterAtlas);
    this.spriteBatch = new SpriteGBufferBatch(gl, this.characterTextures);
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
    this.characterTextures.dispose();
    this.tileBatch.dispose();
    this.gbufferBatch.dispose();
    this.spriteBatch.dispose();
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
    this.spriteBatch.begin(view, cam);
    this.drawTileOverlays(world, cam, view);
    this.drawPickups(world);
    this.drawEnemies(world);
    this.drawProjectiles(world);
    this.drawPlayer(world, player);
    this.gbufferBatch.flush();
    this.spriteBatch.flush();
  }

  /**
   * Queue one baked character-sheet frame into {@link spriteBatch}. Facing &lt; 0 mirrors UVs.
   * `body*` is the gameplay AABB; the sheet is anchored at the feet. Optional `drawScale*`
   * remaps a clip baked at a canonical size onto a differently sized body (enemies).
   */
  private queueCharacterSprite(
    clipId: ClipId,
    animTime: number,
    bodyX: number,
    bodyY: number,
    bodyWidth: number,
    bodyHeight: number,
    facing: number,
    drawScaleX = 1,
    drawScaleY = 1,
  ): void {
    const clip = this.characterAtlas.clips.get(clipId);
    if (clip === undefined) return;
    const frame = sampleClipFrame(clip, animTime);
    const rect = this.characterAtlas.rects.get(frameKey(clipId, frame));
    const drawSize = this.characterAtlas.drawSizes.get(clipId);
    if (rect === undefined || drawSize === undefined) return;

    const drawW = drawSize.width * drawScaleX;
    const drawH = drawSize.height * drawScaleY;
    const x = bodyX + bodyWidth / 2 - drawW / 2;
    const y = bodyY + bodyHeight - drawH;
    const uv = spriteUvFromRect(rect, this.characterAtlas.width, this.characterAtlas.height, facing);
    this.spriteBatch.sprite(x, y, drawW, drawH, uv);
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

  /**
   * Spike tips, conveyor cleats, checkpoint lamps, and goal shafts drawn as G-buffer quads so
   * tiles keep Classic silhouettes instead of flat material slabs. Visual only — collision stays
   * on the tilemap.
   */
  private drawTileOverlays(world: World, cam: CameraOffset, view: ViewSize): void {
    const { map } = world;
    const tileSize = map.tileSize;
    const minTx = Math.max(0, Math.floor(cam.x / tileSize));
    const maxTx = Math.min(map.width - 1, Math.floor((cam.x + view.width) / tileSize));
    const minTy = Math.max(0, Math.floor(cam.y / tileSize));
    const maxTy = Math.min(map.height - 1, Math.floor((cam.y + view.height) / tileSize));
    const hazard = parseColor(palette.hazard);
    const hazardDark = parseColor(palette.hazardDark);
    const rust = parseColor(palette.rust);
    const plateDark = parseColor(palette.plateDark);
    const plateFace = parseColor(palette.plateFace);
    const energy = parseColor(palette.energy);
    const energyDim = parseColor(palette.energyDim);
    const visorGlow = parseColor(palette.visorGlow);
    const uiDim = parseColor(palette.uiDim);
    const white = parseColor(palette.white);
    const nearStructure = parseColor(palette.nearStructure);
    const midStructure = parseColor(palette.midStructure);

    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        const kind = map.tileAt(tx, ty);
        const x = tx * tileSize;
        const y = ty * tileSize;
        switch (kind) {
          case TileKind.Spike: {
            const hash = tileVariation(tx, ty);
            this.gbufferBatch.rect(x, y + 12, tileSize, 4, {
              r: hazardDark[0],
              g: hazardDark[1],
              b: hazardDark[2],
              roughness: 0.35,
              metallic: 0.75,
              emissiveR: hazard[0] * 0.15,
              emissiveG: hazard[1] * 0.15,
              emissiveB: hazard[2] * 0.15,
            });
            for (let i = 0; i < 4; i += 1) {
              const tipH = 6 + ((hash >> (i * 2)) & 1) * 2;
              const tipX = x + i * 4 + 1;
              const tipY = y + 16 - tipH - 4;
              this.gbufferBatch.rect(tipX, tipY, 2, tipH, {
                r: hazard[0],
                g: hazard[1],
                b: hazard[2],
                roughness: 0.28,
                metallic: 0.85,
                emissiveR: hazard[0] * 0.35,
                emissiveG: hazard[1] * 0.35,
                emissiveB: hazard[2] * 0.35,
              });
              this.gbufferBatch.rect(tipX + 1, tipY, 1, tipH, {
                r: hazardDark[0],
                g: hazardDark[1],
                b: hazardDark[2],
                roughness: 0.4,
                metallic: 0.7,
              });
            }
            break;
          }
          case TileKind.ConveyorLeft:
          case TileKind.ConveyorRight: {
            const direction = kind === TileKind.ConveyorRight ? 1 : -1;
            const shift = Math.floor(world.elapsedSec * 60 * direction) % 8;
            for (let i = -8; i < tileSize + 8; i += 8) {
              const cleatX = x + ((((i + shift) % 8) + 8) % 8) + Math.floor(i / 8) * 8;
              if (cleatX < x - 4 || cleatX > x + tileSize) continue;
              const drawX = Math.max(x, cleatX);
              const drawW = Math.min(3, x + tileSize - cleatX);
              if (drawW <= 0) continue;
              this.gbufferBatch.rect(drawX, y + 1, drawW, 2, {
                r: rust[0],
                g: rust[1],
                b: rust[2],
                roughness: 0.55,
                metallic: 0.35,
              });
            }
            break;
          }
          case TileKind.Checkpoint: {
            const active = world.isCheckpointActive(tx, ty);
            const pulse = 0.5 + 0.5 * Math.sin(world.elapsedSec * (active ? 6 : 2));
            this.gbufferBatch.rect(x + 7, y + 2, 2, tileSize - 2, {
              r: plateDark[0],
              g: plateDark[1],
              b: plateDark[2],
              roughness: 0.45,
              metallic: 0.7,
            });
            const lamp = active ? energy : uiDim;
            this.gbufferBatch.rect(x + 5, y + 2, 6, 4, {
              r: lamp[0],
              g: lamp[1],
              b: lamp[2],
              roughness: 0.3,
              metallic: 0.4,
              emissiveR: active ? energy[0] * 0.85 : 0,
              emissiveG: active ? energy[1] * 0.85 : 0,
              emissiveB: active ? energy[2] * 0.85 : 0,
            });
            const core = active ? visorGlow : plateFace;
            this.gbufferBatch.rect(x + 6, y + 3, Math.max(1, 4 * pulse), 2, {
              r: core[0],
              g: core[1],
              b: core[2],
              roughness: 0.25,
              metallic: 0.2,
              emissiveR: active ? visorGlow[0] : 0,
              emissiveG: active ? visorGlow[1] : 0,
              emissiveB: active ? visorGlow[2] : 0,
            });
            break;
          }
          case TileKind.Goal: {
            const wobble = Math.sin(world.elapsedSec * 4) * 1.5;
            this.gbufferBatch.rect(x + 2, y, tileSize - 4, tileSize, {
              r: energyDim[0],
              g: energyDim[1],
              b: energyDim[2],
              roughness: 0.35,
              metallic: 0.15,
              emissiveR: energyDim[0] * 0.55,
              emissiveG: energyDim[1] * 0.55,
              emissiveB: energyDim[2] * 0.55,
            });
            this.gbufferBatch.rect(x + 4, y, tileSize - 8, tileSize, {
              r: energy[0],
              g: energy[1],
              b: energy[2],
              roughness: 0.28,
              metallic: 0.12,
              emissiveR: energy[0] * 0.9,
              emissiveG: energy[1] * 0.9,
              emissiveB: energy[2] * 0.9,
            });
            this.gbufferBatch.rect(x + 6 + wobble * 0.4, y + 2, 3, tileSize - 4, {
              r: visorGlow[0],
              g: visorGlow[1],
              b: visorGlow[2],
              roughness: 0.2,
              metallic: 0.1,
              emissiveR: visorGlow[0],
              emissiveG: visorGlow[1],
              emissiveB: visorGlow[2],
            });
            this.gbufferBatch.rect(x + 7, y + 6 + wobble, 1, 4, {
              r: white[0],
              g: white[1],
              b: white[2],
              roughness: 0.15,
              metallic: 0.05,
              emissiveR: white[0],
              emissiveG: white[1],
              emissiveB: white[2],
            });
            break;
          }
          case TileKind.Scenery: {
            const hash = tileVariation(tx, ty);
            const horizontal = (hash & 1) === 0;
            if (horizontal) {
              this.gbufferBatch.rect(x, y + 6, tileSize, 4, {
                r: nearStructure[0],
                g: nearStructure[1],
                b: nearStructure[2],
                roughness: 0.7,
                metallic: 0.55,
              });
              this.gbufferBatch.rect(x, y + 9, tileSize, 1, {
                r: midStructure[0],
                g: midStructure[1],
                b: midStructure[2],
                roughness: 0.75,
                metallic: 0.5,
              });
              if ((hash & 6) === 0) {
                this.gbufferBatch.rect(x + 6, y + 4, 3, 8, {
                  r: nearStructure[0],
                  g: nearStructure[1],
                  b: nearStructure[2],
                  roughness: 0.7,
                  metallic: 0.55,
                });
              }
            } else {
              this.gbufferBatch.rect(x + 6, y, 4, tileSize, {
                r: nearStructure[0],
                g: nearStructure[1],
                b: nearStructure[2],
                roughness: 0.7,
                metallic: 0.55,
              });
              this.gbufferBatch.rect(x + 9, y, 1, tileSize, {
                r: midStructure[0],
                g: midStructure[1],
                b: midStructure[2],
                roughness: 0.75,
                metallic: 0.5,
              });
            }
            break;
          }
          case TileKind.Empty:
          case TileKind.Solid:
          case TileKind.OneWay:
            break;
          default: {
            const exhaustive: never = kind;
            throw new Error(`Unhandled tile kind in drawTileOverlays: ${String(exhaustive)}`);
          }
        }
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
    const x = pickup.x - 1;
    const y = pickup.y + bob - 1;
    const w = pickup.width + 2;
    const h = pickup.height + 2;
    switch (pickup.kind) {
      case 'energyCell': {
        // Tall canister with glowing window — colour-blind shape language matching Classic.
        const body = parseColor(palette.plateDark);
        const glow = parseColor(palette.energy);
        const tip = parseColor(palette.visorGlow);
        const cap = parseColor(palette.plateLight);
        this.gbufferBatch.rect(x, y, w, h, {
          r: body[0],
          g: body[1],
          b: body[2],
          roughness: 0.45,
          metallic: 0.55,
        });
        this.gbufferBatch.rect(x + 1, y + 2, w - 2, h - 4, {
          r: glow[0],
          g: glow[1],
          b: glow[2],
          emissiveR: glow[0] * 0.85,
          emissiveG: glow[1] * 0.85,
          emissiveB: glow[2] * 0.85,
          roughness: 0.25,
          metallic: 0.2,
        });
        this.gbufferBatch.rect(x + 2, y + 3, Math.max(1, w - 5), h - 6, {
          r: tip[0],
          g: tip[1],
          b: tip[2],
          emissiveR: tip[0],
          emissiveG: tip[1],
          emissiveB: tip[2],
          roughness: 0.2,
          metallic: 0.1,
        });
        this.gbufferBatch.rect(x + 1, y, w - 2, 2, {
          r: cap[0],
          g: cap[1],
          b: cap[2],
          roughness: 0.35,
          metallic: 0.7,
        });
        this.gbufferBatch.rect(x + 1, y + h - 2, w - 2, 2, {
          r: cap[0],
          g: cap[1],
          b: cap[2],
          roughness: 0.35,
          metallic: 0.7,
        });
        break;
      }
      case 'bolt': {
        // Hex-nut silhouette: wide cross of plates + warn core.
        const metal = parseColor(palette.plateLight);
        const warn = parseColor(palette.uiWarn);
        const shade = parseColor(palette.plateShadow);
        this.gbufferBatch.rect(x + 1, y, w - 2, h, {
          r: metal[0],
          g: metal[1],
          b: metal[2],
          roughness: 0.28,
          metallic: 0.9,
        });
        this.gbufferBatch.rect(x, y + 1, w, h - 2, {
          r: metal[0],
          g: metal[1],
          b: metal[2],
          roughness: 0.28,
          metallic: 0.9,
        });
        this.gbufferBatch.rect(x + 2, y + 2, w - 4, h - 4, {
          r: warn[0],
          g: warn[1],
          b: warn[2],
          emissiveR: warn[0] * 0.35,
          emissiveG: warn[1] * 0.35,
          emissiveB: warn[2] * 0.35,
          roughness: 0.4,
          metallic: 0.5,
        });
        this.gbufferBatch.rect(x + 3, y + 3, 1.4, 1.4, {
          r: shade[0],
          g: shade[1],
          b: shade[2],
          roughness: 0.5,
          metallic: 0.8,
        });
        break;
      }
      case 'repairKit': {
        // White case + health cross (distinct from canister / nut).
        const shell = parseColor(palette.shellLight);
        const edge = parseColor(palette.shellDark);
        const cross = parseColor(palette.health);
        this.gbufferBatch.rect(x, y, w, h, {
          r: shell[0],
          g: shell[1],
          b: shell[2],
          roughness: 0.55,
          metallic: 0.05,
        });
        this.gbufferBatch.rect(x, y + h - 1.5, w, 1.5, {
          r: edge[0],
          g: edge[1],
          b: edge[2],
          roughness: 0.6,
          metallic: 0.05,
        });
        this.gbufferBatch.rect(x + w * 0.4, y + 2, Math.max(1.5, w * 0.2), h - 4, {
          r: cross[0],
          g: cross[1],
          b: cross[2],
          emissiveR: cross[0] * 0.55,
          emissiveG: cross[1] * 0.55,
          emissiveB: cross[2] * 0.55,
          roughness: 0.45,
          metallic: 0.05,
        });
        this.gbufferBatch.rect(x + 2, y + h * 0.4, w - 4, Math.max(1.5, h * 0.22), {
          r: cross[0],
          g: cross[1],
          b: cross[2],
          emissiveR: cross[0] * 0.55,
          emissiveG: cross[1] * 0.55,
          emissiveB: cross[2] * 0.55,
          roughness: 0.45,
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
   * Draws one enemy from its procedural sprite sheet (baked from {@link buildEnemyRig} poses
   * with soft edges + ink outline). Telegraph / sealed-core / dying states select alternate clips.
   */
  private drawEnemy(world: World, enemy: Enemy): void {
    const dyingProgress = enemy.state === 'dying' ? 1 - enemy.deathTimer / ENEMY_DEATH_TIME : 0;
    if (dyingProgress >= 1) return;

    const { x, y, width, height } = enemy.body;
    const telegraphing = isEnhancedEnemyTelegraphing(world, enemy);
    const vulnerable = enemy.kind === 'overseer' ? world.isBossVulnerable(enemy) : false;
    const clipId = enemyClipId(enemy.kind, {
      telegraph: telegraphing,
      vulnerable,
      dying: dyingProgress > 0,
    });
    const clip = this.characterAtlas.clips.get(clipId);
    const animTime =
      dyingProgress > 0 && clip !== undefined
        ? dyingClipAnimTime(clip, dyingProgress)
        : enemy.animTime;

    const canonical = enemyCanonicalSize(enemy.kind);
    this.queueCharacterSprite(
      clipId,
      animTime,
      x,
      y,
      width,
      height,
      enemy.direction,
      (width / canonical.width) * ENEMY_VISUAL_SCALE,
      (height / canonical.height) * ENEMY_VISUAL_SCALE,
    );
  }

  private drawProjectiles(world: World): void {
    const dark = parseColor(palette.hazardDark);
    const glow = parseColor(palette.hazard);
    const spark = parseColor(palette.spark);
    for (const projectile of world.projectiles.all) {
      if (!projectile.active) continue;
      const cx = projectile.x;
      const cy = projectile.y;
      const s = PROJECTILE_SIZE;
      // Core + soft halo (Dead Cells bolt) instead of a single pillow square.
      this.gbufferBatch.rect(cx - s * 0.85, cy - s * 0.85, s * 1.7, s * 1.7, {
        r: dark[0],
        g: dark[1],
        b: dark[2],
        a: 0.55,
        emissiveR: glow[0] * 0.45,
        emissiveG: glow[1] * 0.45,
        emissiveB: glow[2] * 0.45,
        roughness: 0.35,
        metallic: 0.5,
      });
      this.gbufferBatch.rect(cx - s * 0.5, cy - s * 0.5, s, s, {
        r: glow[0],
        g: glow[1],
        b: glow[2],
        emissiveR: glow[0] * 0.95,
        emissiveG: glow[1] * 0.95,
        emissiveB: glow[2] * 0.95,
        roughness: 0.25,
        metallic: 0.6,
      });
      this.gbufferBatch.rect(cx - s * 0.22, cy - s * 0.22, s * 0.44, s * 0.44, {
        r: spark[0],
        g: spark[1],
        b: spark[2],
        emissiveR: spark[0],
        emissiveG: spark[1],
        emissiveB: spark[2],
        roughness: 0.2,
        metallic: 0.3,
      });
    }
  }

  /**
   * Draws Optimus from the high-FPS procedural sprite sheet (baked from {@link buildOptimusRig}
   * with hand-drawn soft edges / ink outline). Classic Canvas2D still uses the flat sprites path.
   */
  private drawPlayer(world: World, playerPos: Point): void {
    const { player } = world;
    const blinkedOut =
      player.isInvulnerable && Math.floor(player.invulnerableTime * INVULNERABLE_BLINK_HZ) % 2 === 1;
    if (blinkedOut) return;

    // Soft contact shadow under the feet — slightly wider than the 10×22 hitbox so the
    // gameplay AABB stays readable under the larger Tesla silhouette.
    const shadowW = PLAYER_WIDTH + 6;
    const shadowX = playerPos.x + PLAYER_WIDTH / 2 - shadowW / 2;
    this.gbufferBatch.rect(shadowX, playerPos.y + PLAYER_HEIGHT - 1, shadowW, 3, {
      r: 0.02,
      g: 0.03,
      b: 0.05,
      a: 0.35,
      roughness: 1,
      metallic: 0,
    });

    this.queueCharacterSprite(
      optimusClipId(player.state),
      player.animTime,
      playerPos.x,
      playerPos.y,
      PLAYER_WIDTH,
      PLAYER_HEIGHT,
      player.facing,
    );
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
    const scrim = parseColor('rgb(8 10 18 / 0.38)');
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
    // Match the Enhanced Optimus visual footprint, not the 10×22 collision box.
    const gw = WORLD_DRAW_WIDTH;
    const gh = WORLD_DRAW_HEIGHT;
    for (const ghost of this.ghosts) {
      const life = 1 - ghost.age / GHOST_LIFETIME;
      const alpha = 0.48 * life * life * life;
      if (alpha <= 0.02) continue;
      const gx = ghost.x + PLAYER_WIDTH / 2 - gw / 2;
      const gy = ghost.y + PLAYER_HEIGHT - gh;
      this.forwardBatch.rect(gx - 2, gy - 2, gw + 4, gh + 4, outer[0], outer[1], outer[2], alpha * 0.22);
      this.forwardBatch.rect(gx, gy, gw, gh, mid[0], mid[1], mid[2], alpha * 0.5);
      this.forwardBatch.rect(gx + gw * 0.18, gy + gh * 0.12, gw * 0.64, gh * 0.76, mid[0], mid[1], mid[2], alpha * 0.75);
      this.forwardBatch.rect(
        gx + gw * 0.32,
        gy + gh * 0.22,
        gw * 0.36,
        gh * 0.45,
        core[0],
        core[1],
        core[2],
        alpha * 0.32,
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
    const side = Math.sin(player.animTime * 42) * 1.2;
    const length = (10 + flicker * 10) * clamp(0.35 + player.energyRatio, 0.35, 1);
    const centerX = player.body.x + PLAYER_WIDTH / 2;
    const topY = player.body.y + PLAYER_HEIGHT;
    this.forwardBatch.rect(centerX - 7, topY, 14, length * 0.75, flame[0], flame[1], flame[2], 0.26);
    this.forwardBatch.rect(centerX - 5, topY, 10, length, flame[0], flame[1], flame[2], 0.58);
    this.forwardBatch.rect(centerX - 3.2, topY, 6.4, length * 0.9, hot[0], hot[1], hot[2], 0.92);
    this.forwardBatch.rect(centerX - 1.5, topY, 3, length * 1.2, spark[0], spark[1], spark[2], 1);
    this.forwardBatch.rect(centerX - 0.7, topY + length * 0.15, 1.4, length * 0.55, hot[0], hot[1], hot[2], 0.85);
    this.forwardBatch.rect(centerX - 4.5 + side, topY + length * 0.2, 2.6, length * 0.45, flame[0], flame[1], flame[2], 0.38);
    this.forwardBatch.rect(centerX + 1.9 - side, topY + length * 0.25, 2.6, length * 0.4, flame[0], flame[1], flame[2], 0.32);
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
