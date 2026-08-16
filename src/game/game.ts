/**
 * The game shell.
 *
 * Owns the world, drives the simulation, and assembles the frame request the
 * pipeline consumes.
 */

import { Device, BlendMode } from '../gfx/device.ts';
import { Pipeline, type Atmosphere } from '../render/pipeline.ts';
import { LightList, createLight, LightType, type Light } from '../render/lights.ts';
import { Camera } from '../scene/camera.ts';
import { ParallaxRenderer, type ParallaxLayer } from '../scene/parallax.ts';
import { Atlas } from '../art/atlas.ts';
import { buildCoreAtlasSources } from '../art/library.ts';
import { buildOptimusAtlasSources } from '../art/optimus.ts';
import {
  buildAresAtlasSources,
  buildAresLayers,
  buildAresAtmosphere,
  ARES_SUN_WORLD,
} from '../world/biomes/ares.ts';
import { buildAresApproach, type RoomDefinition } from '../world/rooms/ares-approach.ts';
import { SpriteBatch, packColor, packMaterial } from '../gfx/batch.ts';
import { fxRng } from '../core/rng.ts';
import { Depth } from '../core/config.ts';
import { PhysicsWorld } from './physics.ts';
import { PlayerController } from './player/controller.ts';
import { Autopilot, type AutopilotOptions } from './autopilot.ts';
import { OptimusAnimator, type AnimationInput } from './player/animator.ts';
import { OptimusRenderer } from './player/renderer.ts';
import { input } from '../core/input.ts';
import type { GameLoop } from '../core/loop.ts';
import { NoiseField } from '../core/math/noise.ts';
import { clamp01 } from '../core/math/scalar.ts';

interface Mote {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  depth: number;
  brightness: number;
  /** Warm sunlit dust versus cooler shadowed ash. */
  warmth: number;
}

const driftNoise = new NoiseField(0x4d51);

export class Game {
  readonly camera = new Camera();
  readonly lights = new LightList();
  readonly physics = new PhysicsWorld();
  atmosphere: Atmosphere = buildAresAtmosphere();

  private atlas!: Atlas;
  private parallax!: ParallaxRenderer;
  private layers: ParallaxLayer[] = [];
  private room!: RoomDefinition;
  private loop: GameLoop | null = null;

  player!: PlayerController;
  animator!: OptimusAnimator;
  private optimusRenderer!: OptimusRenderer;

  private readonly motes: Mote[] = [];
  private readonly dynamicLights: Light[] = [];
  /** Per-light flicker amplitude, parallel to `dynamicLights`. */
  private readonly lightFlicker: number[] = [];
  private readonly baseIntensity: number[] = [];

  /**
   * The cyan light Optimus casts on his surroundings.
   *
   * This does three jobs at once: it puts the character's signature colour into
   * the frame (measured at 20x below target without it), it separates him from
   * a warm environment by lighting it cool where he stands, and it makes him
   * read as a powered machine rather than a lit sprite.
   */
  private playerLight!: Light;

  private time = 0;

  /** Harness-only overrides. */
  private cameraOverride: { x: number; y: number; viewHeight: number } | null = null;
  private autopilot: Autopilot | null = null;
  private autopilotOptions: AutopilotOptions | null = null;
  /**
   * The autopilot's current input, mutated in place.
   *
   * The tape closure is installed once and reads from this object. Reinstalling
   * the tape every step is not equivalent: `setTape` clears all held actions,
   * which registered a fresh press on every button on every single frame.
   */
  private readonly autopilotFrame: { moveX: number; moveY: number; held: boolean[] } = {
    moveX: 0,
    moveY: 0,
    held: new Array<boolean>(16).fill(false),
  };

  constructor(
    readonly device: Device,
    readonly pipeline: Pipeline,
  ) {}

  async load(): Promise<void> {
    this.atlas = new Atlas(
      this.device,
      [...buildCoreAtlasSources(), ...buildAresAtlasSources(), ...buildOptimusAtlasSources()],
      4096,
    );
    this.parallax = new ParallaxRenderer(this.atlas, this.camera);
    this.layers = buildAresLayers();
    this.room = buildAresApproach();

    this.buildCollision();
    this.buildLights();
    this.buildAmbientDust();

    this.animator = new OptimusAnimator();
    this.optimusRenderer = new OptimusRenderer(this.atlas, this.animator.skeleton);
    this.player = new PlayerController(this.physics, this.room.spawn.x, this.room.spawn.y);
    this.autopilot = new Autopilot(this.physics, this.player);

    this.camera.setBounds(this.room.bounds);
    this.camera.viewHeightMetres = 9.6;
    this.camera.snapTo(this.player.feetX, this.player.feetY - 1.4);
  }

  attachLoop(loop: GameLoop): void {
    this.loop = loop;
  }

  resize(width: number, height: number): void {
    this.camera.setViewport(width, height);
  }

  private buildCollision(): void {
    this.physics.clear();
    for (const platform of this.room.platforms) {
      this.physics.addSolid(
        platform.x,
        platform.y,
        platform.width,
        platform.height,
        platform.kind,
      );
    }
  }

  private buildLights(): void {
    // The sun: low, hard, and warm, raking in from the direction it occupies in
    // the sky texture, so the baked art and the dynamic lighting agree.
    this.dynamicLights.push(
      createLight({
        type: LightType.Directional,
        angle: this.sunAngle,
        r: 1.0,
        g: 0.72,
        b: 0.46,
        intensity: 1.5,
        shadowStrength: 0.82,
      }),
    );
    this.lightFlicker.push(0);
    this.baseIntensity.push(1.5);

    // A broad warm fill, so the scene is not lit by a single hard source with
    // nothing at all filling its shadows.
    this.dynamicLights.push(
      createLight({
        type: LightType.Point,
        x: ARES_SUN_WORLD.x * 0.4,
        y: ARES_SUN_WORLD.y * 0.4,
        radius: 46,
        r: 1.0,
        g: 0.66,
        b: 0.42,
        intensity: 0.8,
        shadowStrength: 0,
        falloffExponent: 1.4,
      }),
    );
    this.lightFlicker.push(0);
    this.baseIntensity.push(0.8);

    this.playerLight = createLight({
      type: LightType.Point,
      radius: 3.0,
      r: 0.247,
      g: 0.914,
      b: 1.0,
      intensity: 0.62,
      shadowStrength: 0,
      falloffExponent: 2.8,
    });
    this.dynamicLights.push(this.playerLight);
    this.lightFlicker.push(0);
    this.baseIntensity.push(0.62);

    for (const definition of this.room.lights) {
      this.dynamicLights.push(
        createLight({
          type: LightType.Point,
          x: definition.x,
          y: definition.y,
          radius: definition.radius,
          r: definition.color[0],
          g: definition.color[1],
          b: definition.color[2],
          intensity: definition.intensity,
          shadowStrength: definition.shadowStrength,
          falloffExponent: 2.3,
        }),
      );
      this.lightFlicker.push(definition.flicker);
      this.baseIntensity.push(definition.intensity);
    }
  }

  private buildAmbientDust(): void {
    const rng = fxRng;
    for (let i = 0; i < 420; i++) {
      // Biased toward the near depths, where motes are large enough to read.
      const depth = Math.pow(rng.next(), 1.7) * 7;
      this.motes.push({
        x: rng.range(-40, 70),
        y: rng.range(-14, 3),
        size: rng.range(0.022, 0.07) * (1 + (7 - depth) * 0.12),
        speed: rng.range(0.2, 0.95),
        phase: rng.range(0, Math.PI * 2),
        depth,
        brightness: rng.range(0.2, 1),
        warmth: rng.next(),
      });
    }
  }

  fixedUpdate(dt: number, simTime: number): void {
    this.time += dt;

    // The autopilot drives input rather than replacing the controller, so a
    // recorded run exercises exactly the same movement code a player would.
    if (this.autopilot && this.autopilotOptions) {
      const frame = this.autopilot.compute(this.autopilotOptions, dt);
      this.autopilotFrame.moveX = frame.moveX ?? 0;
      this.autopilotFrame.moveY = frame.moveY ?? 0;
      const held = frame.held ?? [];
      for (let i = 0; i < this.autopilotFrame.held.length; i++) {
        this.autopilotFrame.held[i] = held[i] ?? false;
      }
    }

    input.beginStep(simTime);
    this.player.update(input, dt);

    // Landing shakes the camera in proportion to the real impact speed, so a
    // short hop and a long drop feel genuinely different.
    if (this.player.landedThisStep > 3) {
      this.camera.addTrauma(clamp01(this.player.landedThisStep / 30) * 0.45);
    }
    if (this.player.dashedThisStep) {
      this.camera.addTrauma(0.12);
    }
  }

  render(_alpha: number, _dt: number, unscaledDt: number): void {
    const player = this.player;

    const animationInput: AnimationInput = {
      speed: player.speed,
      velocityX: player.velocityX,
      velocityY: player.velocityY,
      grounded: player.grounded,
      facing: player.facing,
      groundAngle: player.groundAngle,
      groundY: player.groundY,
    };
    this.animator.update(animationInput, unscaledDt, player.feetX, player.feetY);

    if (this.cameraOverride) {
      this.camera.viewHeightMetres = this.cameraOverride.viewHeight;
      this.camera.snapTo(
        player.feetX + this.cameraOverride.x,
        player.feetY + this.cameraOverride.y,
      );
    } else {
      this.camera.follow(
        player.feetX,
        // Frame on the chest rather than the feet, so the character sits on the
        // lower third of the screen and the space they are moving into is
        // visible.
        player.feetY - 1.15,
        player.velocityX,
        player.velocityY,
        unscaledDt,
      );
    }
    this.camera.update(unscaledDt);

    this.updateLights();
    this.updateGodRaySource();

    this.pipeline.render({
      camera: this.camera,
      atmosphere: this.atmosphere,
      lights: this.lights,
      timeSeconds: this.time,
      drawGeometry: (batch) => this.drawGeometry(batch),
      drawOccluders: (batch) => this.drawOccluders(batch),
      drawContactAO: (batch) => this.drawContactAO(batch),
    });

    if (this.loop) {
      this.pipeline.updateDynamicResolution(this.loop.timings.frameMs, 1000 / 60);
    }
  }

  /**
   * Places the god-ray source in the sun's direction relative to the camera.
   *
   * The sun is effectively at infinity, so pinning its shafts to a fixed world
   * position is wrong: the radial effect fades to nothing the moment its source
   * leaves the frame, and a fixed point is off-screen for all but a sliver of
   * the level. Anchoring it to the camera keeps the shafts radiating from the
   * correct direction wherever the player is.
   */
  private updateGodRaySource(): void {
    const angle = this.sunAngle;
    // Just inside the frame edge: far enough out that the shafts read as
    // parallel, close enough that the radial falloff still covers the screen.
    const reach = 0.46;
    this.atmosphere.godRayX = this.camera.x + Math.cos(angle) * this.camera.viewWidthMetres * reach;
    this.atmosphere.godRayY = this.camera.y + Math.sin(angle) * this.camera.viewHeightMetres * reach;
  }

  /** Direction of the key light, shared by the sun light and its god rays. */
  private readonly sunAngle = -(Math.PI - 0.38);

  private updateLights(): void {
    // Track the chest, which is where the power core sits.
    this.playerLight.x = this.player.feetX;
    this.playerLight.y = this.player.feetY - 1.15;
    // Brighten with speed, so movement visibly energises the character.
    const exertion = Math.min(this.player.speed / 8.4, 1);
    this.playerLight.intensity = 0.58 + exertion * 0.34;

    this.lights.clear();
    for (let i = 0; i < this.dynamicLights.length; i++) {
      const light = this.dynamicLights[i]!;
      const flicker = this.lightFlicker[i]!;
      if (flicker > 0) {
        // Two incommensurate frequencies, so the flicker never settles into an
        // obvious rhythm.
        const wobble =
          Math.sin(this.time * 3.1 + i * 2.3) * 0.55 + driftNoise.noise2(this.time * 1.9, i * 13) * 0.45;
        light.intensity = this.baseIntensity[i]! * (1 + wobble * flicker);
      }
      this.lights.add(light);
    }
  }

  private drawGeometry(batch: SpriteBatch): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    // Back to front: there is no depth buffer, so submission order is the only
    // thing determining occlusion.
    this.parallax.drawBackground(batch, this.layers, this.time);

    this.drawPlatforms(batch);
    this.drawProps(batch);

    this.optimusRenderer.draw(batch, this.animator.skeleton, this.player.facing);

    this.drawMotes(batch);

    batch.setBlend(BlendMode.Premultiplied);
    this.parallax.drawForeground(batch, this.layers, this.time);
  }

  private drawPlatforms(batch: SpriteBatch): void {
    const white = packColor(1, 1, 1, 1);
    const material = packMaterial(0, 0.5, 0.2, 0);
    const visible = this.camera.getVisibleBounds(4);

    for (const platform of this.room.platforms) {
      if (
        platform.x + platform.width / 2 < visible.minX ||
        platform.x - platform.width / 2 > visible.maxX
      ) {
        continue;
      }
      const entry = this.atlas.get(platform.sprite);
      batch.draw(
        platform.x,
        platform.y,
        platform.width,
        platform.height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        Depth.Playfield,
        white,
        material,
        0,
      );
    }
  }

  /**
   * Contact occlusion: soft pools where objects meet surfaces.
   *
   * Accumulated additively into a dedicated single-channel target, which the
   * lighting pass then uses to attenuate both ambient and direct light.
   *
   * This deliberately does *not* go into the G-buffer. WebGL2 has no
   * per-attachment blend state, so a multiply blend aimed at the albedo also
   * scaled the normal, material, and depth attachments — flipping the normals
   * in the affected rectangle and turning a soft pool into a hard black box.
   *
   * The player's pool shrinks and fades with height, which is what makes a jump
   * read as leaving the ground rather than merely translating upward.
   */
  private drawContactAO(batch: SpriteBatch): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Additive);

    const entry = this.atlas.get('aoBlob');
    const material = packMaterial(1, 1, 0, 0);
    const visible = this.camera.getVisibleBounds(3);

    /**
     * @param surfaceY World Y of the surface the pool sits on.
     *
     * The ellipse is offset downward so the great majority of it lands *below*
     * the surface line. Centring it on the line put most of the pool in empty
     * air above the platform, where there is no geometry to darken — the
     * buffer was being written correctly and read correctly, and still nothing
     * was visible.
     */
    const blob = (x: number, surfaceY: number, width: number, density: number): void => {
      const height = width * 0.62;
      batch.draw(
        x,
        surfaceY + height * 0.38,
        width,
        height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        Depth.Playfield,
        // Premultiplied, and additive, so the colour *is* the density.
        packColor(density, density, density, density),
        material,
        0,
      );
    };

    for (const prop of this.room.props) {
      if (!prop.castsShadow) continue;
      if (prop.x < visible.minX || prop.x > visible.maxX) continue;
      // Nudged below the surface so the pool sits on the platform's top face.
      blob(prop.x + 0.06, prop.y + prop.height / 2, prop.width * 2.3, 1.0);
    }

    const player = this.player;
    const heightAboveGround = Math.max(0, player.groundY - player.feetY);
    // Fades over two metres, roughly half a jump.
    const fade = clamp01(1 - heightAboveGround / 2.2);
    if (fade > 0.02) {
      // Widening with height mimics a penumbra spreading as the occluder moves
      // away from the surface.
      const width = 1.9 * (1 + heightAboveGround * 0.30);
      blob(player.feetX + 0.05, player.groundY, width, fade * fade);
    }

    batch.setBlend(BlendMode.Premultiplied);
  }

  private drawProps(batch: SpriteBatch): void {
    const white = packColor(1, 1, 1, 1);
    const visible = this.camera.getVisibleBounds(3);

    for (const prop of this.room.props) {
      if (prop.x < visible.minX || prop.x > visible.maxX) continue;
      const entry = this.atlas.get(prop.sprite);
      batch.draw(
        prop.x,
        prop.y,
        prop.width,
        prop.height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        Depth.Playfield,
        white,
        packMaterial(prop.emissive, 0.5, 0.5, 0),
        prop.rotation,
      );
    }
  }

  /**
   * Airborne dust.
   *
   * Advected along a curl-noise field so the air swirls rather than sliding in
   * straight lines, drawn additively across a range of depths.
   */
  private drawMotes(batch: SpriteBatch): void {
    const entry = this.atlas.get('mote');
    batch.setBlend(BlendMode.Additive);
    const material = packMaterial(1, 1, 0, 0);
    const visible = this.camera.getVisibleBounds(2);

    for (const mote of this.motes) {
      const drift = driftNoise.noise2(mote.x * 0.09 + this.time * 0.07, mote.y * 0.09);
      const bob = Math.sin(this.time * mote.speed + mote.phase) * 0.3;

      const x = mote.x + this.time * mote.speed * 0.42 + drift * 1.1;
      const y = mote.y + bob + drift * 0.5;

      const parallax = this.camera.parallaxFactor(mote.depth);
      const offsetX = this.camera.x * (1 - parallax);
      const offsetY = this.camera.y * (1 - parallax);

      // Wrap around the camera so the field is effectively infinite without
      // simulating motes nowhere near the view.
      const span = 90;
      let wrappedX = x;
      const relativeX = x + offsetX - this.camera.x;
      if (relativeX < -span / 2) wrappedX += span;
      else if (relativeX > span / 2) wrappedX -= span;

      const finalX = wrappedX + offsetX;
      const finalY = y + offsetY;
      if (finalX < visible.minX || finalX > visible.maxX) continue;
      if (finalY < visible.minY || finalY > visible.maxY) continue;

      const twinkle = 0.55 + Math.sin(this.time * 2.1 + mote.phase) * 0.45;
      const alpha = clamp01((mote.brightness * twinkle) / (1 + mote.depth * 0.4));

      const r = (0.95 * mote.warmth + 0.55 * (1 - mote.warmth)) * alpha;
      const g = (0.68 * mote.warmth + 0.52 * (1 - mote.warmth)) * alpha;
      const b = (0.44 * mote.warmth + 0.62 * (1 - mote.warmth)) * alpha;

      batch.draw(
        finalX,
        finalY,
        mote.size,
        mote.size,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        mote.depth,
        packColor(r, g, b, alpha),
        material,
        0,
      );
    }

    batch.setBlend(BlendMode.Premultiplied);
  }

  /** Silhouettes for the shadow and god-ray passes. */
  private drawOccluders(batch: SpriteBatch): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    const white = packColor(1, 1, 1, 1);
    const material = packMaterial(0, 1, 0, 0);
    const visible = this.camera.getVisibleBounds(4);

    // Every platform occludes the sky, including the ground slabs. Shafts need
    // something to break over, and terrain is the largest such silhouette in
    // the scene. Self-shadowing is avoided by the ray's start bias plus the
    // soft-maximum accumulation, which only darkens a surface when a *nearer*
    // occluder sits between it and the light.
    for (const platform of this.room.platforms) {
      if (
        platform.x + platform.width / 2 < visible.minX ||
        platform.x - platform.width / 2 > visible.maxX
      ) {
        continue;
      }
      const entry = this.atlas.get(platform.sprite);
      batch.draw(
        platform.x,
        platform.y,
        platform.width,
        platform.height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        Depth.Playfield,
        white,
        material,
        0,
      );
    }

    for (const prop of this.room.props) {
      if (!prop.castsShadow) continue;
      if (prop.x < visible.minX || prop.x > visible.maxX) continue;
      const entry = this.atlas.get(prop.sprite);
      batch.draw(
        prop.x,
        prop.y,
        prop.width,
        prop.height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        Depth.Playfield,
        white,
        material,
        prop.rotation,
      );
    }

    // The player is the most important caster in the game: their own shadow
    // falling across the environment is much of what makes them feel present
    // in it rather than composited on top.
    this.optimusRenderer.drawOccluder(batch, this.animator.skeleton, this.player.facing);

    // The foreground silhouette is the main god-ray occluder: shafts breaking
    // over the top of it is the effect the whole layer exists to produce.
    const foreground = this.layers.find((layer) => layer.sprite === 'ares.foreground');
    if (foreground) this.parallax.draw(batch, foreground, this.time);
  }

  // --- Harness hooks -------------------------------------------------------

  setCameraOverride(x: number, y: number, viewHeightMetres: number): void {
    this.cameraOverride = { x, y, viewHeight: viewHeightMetres };
  }

  clearCameraOverride(): void {
    this.cameraOverride = null;
  }

  setAutopilot(options: AutopilotOptions | null): void {
    this.autopilotOptions = options;
    this.autopilot?.reset();
    if (options) {
      // Installed once; the closure reads the frame that fixedUpdate mutates.
      input.setTape(() => this.autopilotFrame);
    } else {
      input.setTape(null);
    }
  }

  teleportPlayer(x: number, y: number): void {
    this.player.teleport(x, y);
    this.camera.snapTo(x, y - 1.15);
  }

  stats(): Record<string, number> {
    const [width, height] = this.pipeline.internalResolution;
    return {
      drawCalls: this.device.frameStats.drawCalls,
      triangles: this.device.frameStats.triangles,
      textureBinds: this.device.frameStats.textureBinds,
      fullscreenPasses: this.pipeline.fullscreenPasses,
      lights: this.lights.count,
      lightsCulled: this.lights.culled,
      platforms: this.room.platforms.length,
      props: this.room.props.length,
      motes: this.motes.length,
      layers: this.layers.length,
      renderWidth: width,
      renderHeight: height,
      playerX: this.player.feetX,
      playerY: this.player.feetY,
      playerVX: this.player.velocityX,
      playerVY: this.player.velocityY,
      grounded: this.player.grounded ? 1 : 0,
      simMs: this.loop?.timings.simMs ?? 0,
      renderMs: this.loop?.timings.renderMs ?? 0,
      frameMs: this.loop?.timings.frameMs ?? 0,
    };
  }

  get elapsed(): number {
    return this.time;
  }
}
