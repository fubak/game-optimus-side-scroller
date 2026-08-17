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
 *  3. **Background pass** — {@link backgroundTarget} gets the sky gradient, parallax layers and
 *     atmospheric scrim, unlit. Kept separate from the G-buffer so it is cheap and never needs a
 *     normal/material of its own.
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
 * All render targets run at the fixed 480×270 world-view resolution (matching gameplay's own
 * coordinate space and Classic's pixel-art look); only the final tonemap present upscales to the
 * device's real buffer size, exactly like the Stage 1/2 blit it replaces.
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
import type { RenderSettings } from '../settings';
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
import { TexFormat } from './texture';

/** Soft-threshold cutoff and overall strength for Stage 7's emissive-only bloom (`post/bloom.ts`). */
const BLOOM_THRESHOLD = 0.35;
const BLOOM_INTENSITY = 1.15;

/** Bound on the internal grain-hash time counter (seconds); wraps so long sessions keep float precision. */
const TIME_WRAP_SEC = 1000;

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

/** Matches the fade duration `drawDashGhost` uses in Classic (`renderer.ts`). */
const GHOST_LIFETIME = 0.18;

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

function uvRectFromAtlasRect(rect: AtlasRect, atlasWidth: number, atlasHeight: number): UvRect {
  return {
    u0: rect.x / atlasWidth,
    v0: rect.y / atlasHeight,
    u1: (rect.x + rect.width) / atlasWidth,
    v1: (rect.y + rect.height) / atlasHeight,
  };
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
        createParallaxLayers({ seed: world.level.seed, viewWidth: INTERNAL_WIDTH, viewHeight: INTERNAL_HEIGHT }),
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
      this.ghosts.push({ x: player.body.x, y: player.body.y, age: 0 });
    }
    for (const ghost of this.ghosts) ghost.age += dtSec;
    this.ghosts = this.ghosts.filter((ghost) => ghost.age < GHOST_LIFETIME);

    this.prevCamera = this.currCamera ?? { x: world.camera.renderX, y: world.camera.renderY };
    this.currCamera = { x: world.camera.renderX, y: world.camera.renderY };
    this.prevPlayer = this.currPlayer ?? { x: player.body.x, y: player.body.y };
    this.currPlayer = { x: player.body.x, y: player.body.y };
  }

  /**
   * Resize the GL backbuffer to match the display's real buffer (device pixels). Every internal
   * render target stays pinned at 480×270 — only the final tonemap present targets this size.
   */
  resize(bufferWidth: number, bufferHeight: number): void {
    const width = Math.max(1, Math.round(bufferWidth));
    const height = Math.max(1, Math.round(bufferHeight));
    if (width === this.backbufferWidth && height === this.backbufferHeight) return;
    this.backbufferWidth = width;
    this.backbufferHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
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
      createParallaxLayers({ seed: world.level.seed, viewWidth: INTERNAL_WIDTH, viewHeight: INTERNAL_HEIGHT }),
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

    const view: ViewSize = { width: INTERNAL_WIDTH, height: INTERNAL_HEIGHT };
    const cam: CameraOffset = this.interpolatedCamera(world, alpha);
    const player = this.interpolatedPlayer(world, alpha);

    this.gpuTimer.begin();

    this.drawGeometryPass(world, view, cam, player);
    this.drawOccluderPass(world, view, cam, player);
    this.drawBackgroundPass(view, cam);

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
        this.tileBatch.tile(tx * tileSize, ty * tileSize, tileSize, tileSize, uv, emissive);
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

  /** Fills {@link backgroundTarget}: sky gradient, parallax layers, atmospheric scrim. Unlit. */
  private drawBackgroundPass(view: ViewSize, cam: CameraOffset): void {
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
    const color = parseColor(palette.visorGlow);
    for (const ghost of this.ghosts) {
      const alpha = 0.3 * (1 - ghost.age / GHOST_LIFETIME);
      if (alpha <= 0) continue;
      this.forwardBatch.rect(ghost.x, ghost.y, PLAYER_WIDTH, PLAYER_HEIGHT, color[0], color[1], color[2], alpha);
    }
  }

  private drawJetpackFlame(world: World): void {
    const { player } = world;
    if (!player.isAlive || player.state !== 'thrust') return;
    const flame = parseColor(palette.flame);
    const flicker = 0.6 + Math.abs(Math.sin(player.animTime * 30)) * 0.4;
    const length = (5 + flicker * 5) * clamp(0.35 + player.energyRatio, 0.35, 1);
    const centerX = player.body.x + PLAYER_WIDTH / 2;
    const topY = player.body.y + PLAYER_HEIGHT;
    this.forwardBatch.rect(centerX - 3, topY, 6, length, flame[0], flame[1], flame[2], 0.85);
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
          const size = Math.max(1, Math.round(particle.size * progress + 0.4));
          const alpha = clamp(progress * 1.4, 0, 1);
          this.particleBatch.particle(particle.x, particle.y, size, size, color[0], color[1], color[2], alpha);
          break;
        }
        case 'dust':
        case 'exhaust': {
          const size = Math.max(1, Math.round(particle.size + (1 - progress) * 2));
          this.particleBatch.particle(
            particle.x - size / 2,
            particle.y - size / 2,
            size,
            size,
            color[0],
            color[1],
            color[2],
            progress * 0.55,
          );
          break;
        }
        case 'pickup': {
          const height = Math.max(1, Math.round(1 + progress * 2));
          this.particleBatch.particle(particle.x, particle.y, 1, height, color[0], color[1], color[2], progress);
          break;
        }
        case 'ring': {
          const radius = Math.max(0.5, (1 - progress) * particle.size * 8);
          this.particleBatch.particle(
            particle.x - radius,
            particle.y - radius,
            radius * 2,
            radius * 2,
            color[0],
            color[1],
            color[2],
            progress * 0.7,
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
