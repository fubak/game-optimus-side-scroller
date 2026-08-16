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
import {
  buildAresAtlasSources,
  buildAresLayers,
  buildAresAtmosphere,
  ARES_SUN_WORLD,
} from '../world/biomes/ares.ts';
import { SpriteBatch, packColor, packMaterial } from '../gfx/batch.ts';
import { fxRng } from '../core/rng.ts';
import { Depth } from '../core/config.ts';
import type { GameLoop } from '../core/loop.ts';
import { NoiseField } from '../core/math/noise.ts';
import { clamp01 } from '../core/math/scalar.ts';

/** A piece of playfield geometry. */
interface Prop {
  x: number;
  y: number;
  width: number;
  height: number;
  sprite: string;
  depth: number;
  rotation: number;
  emissive: number;
  /**
   * Whether this prop writes into the occluder mask.
   *
   * Only objects that stand *in front of* the backdrop should cast. Putting the
   * terrain itself in the mask makes every surface shadow itself, which reads
   * as a uniform grey wash rather than as actual shadows.
   */
  castsShadow: boolean;
  tint?: [number, number, number];
}

interface Mote {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  depth: number;
  brightness: number;
  /** Warm dust versus cool ash, for subtle variety. */
  warmth: number;
}

const driftNoise = new NoiseField(0x4d51);

export class Game {
  readonly camera = new Camera();
  readonly lights = new LightList();
  atmosphere: Atmosphere = buildAresAtmosphere();

  private atlas!: Atlas;
  private parallax!: ParallaxRenderer;
  private layers: ParallaxLayer[] = [];
  private loop: GameLoop | null = null;

  private readonly props: Prop[] = [];
  private readonly motes: Mote[] = [];
  private readonly dynamicLights: Light[] = [];
  private sun!: Light;

  private time = 0;

  constructor(
    readonly device: Device,
    readonly pipeline: Pipeline,
  ) {}

  async load(): Promise<void> {
    this.atlas = new Atlas(
      this.device,
      [...buildCoreAtlasSources(), ...buildAresAtlasSources()],
      2048,
    );
    this.parallax = new ParallaxRenderer(this.atlas, this.camera);
    this.layers = buildAresLayers();
    this.buildScene();
  }

  attachLoop(loop: GameLoop): void {
    this.loop = loop;
  }

  resize(width: number, height: number): void {
    this.camera.setViewport(width, height);
  }

  private buildScene(): void {
    const rng = fxRng;

    // --- Ground -----------------------------------------------------------
    // One long slab rather than a grid of unit tiles. Tiling a 1 m rock texture
    // produced an obvious repeating grid; a wide slab with its own internal
    // variation reads as continuous terrain.
    const groundY = 6.2;
    for (let i = -6; i <= 6; i++) {
      this.props.push({
        x: i * 16,
        y: groundY,
        width: 16.05,
        height: 8,
        sprite: 'ares.ground',
        depth: Depth.Playfield,
        rotation: 0,
        emissive: 0,
        castsShadow: false,
      });
    }

    // --- Mechanical props -------------------------------------------------
    // Sparse and deliberately placed. Clutter would fight the silhouette
    // reading the composition depends on.
    const crates: [number, number][] = [
      [-9.4, 0.95],
      [-8.6, 0.62],
      [-3.2, 1.15],
      [4.8, 0.85],
      [5.55, 0.58],
      [11.2, 1.05],
    ];
    for (const [x, size] of crates) {
      this.props.push({
        x,
        y: groundY - 4 - size / 2 + 0.05,
        width: size,
        height: size,
        sprite: 'panel',
        depth: Depth.Playfield,
        rotation: rng.range(-0.04, 0.04),
        emissive: 0,
        castsShadow: true,
      });
    }

    // Lit consoles: the cyan accents, and the scene's practical light sources.
    const consoles = [-6.1, 1.9, 8.7];
    for (const x of consoles) {
      this.props.push({
        x,
        y: groundY - 4 - 0.4,
        width: 1.2,
        height: 0.8,
        sprite: 'panelLit',
        depth: Depth.Playfield,
        rotation: 0,
        emissive: 0.7,
        castsShadow: true,
      });

      this.dynamicLights.push(
        createLight({
          type: LightType.Point,
          x,
          y: groundY - 4 - 0.55,
          radius: 5.2,
          r: 0.247,
          g: 0.914,
          b: 1.0,
          intensity: 1.25,
          shadowStrength: 0.75,
          falloffExponent: 2.4,
        }),
      );
    }

    // --- Airborne dust ----------------------------------------------------
    for (let i = 0; i < 340; i++) {
      const depth = Math.pow(rng.next(), 1.6) * 7;
      this.motes.push({
        x: rng.range(-40, 40),
        y: rng.range(-8, 7),
        // Nearer motes are larger, which reinforces the depth read.
        size: rng.range(0.025, 0.075) * (1 + (7 - depth) * 0.12),
        speed: rng.range(0.2, 0.95),
        phase: rng.range(0, Math.PI * 2),
        depth,
        brightness: rng.range(0.2, 1),
        warmth: rng.next(),
      });
    }

    // --- The sun ----------------------------------------------------------
    // Low and raking. The angle points up-left toward where the sun sits in the
    // sky texture, so the baked art and the dynamic lighting agree.
    this.sun = createLight({
      type: LightType.Directional,
      angle: -(Math.PI - 0.38),
      r: 1.0,
      g: 0.72,
      b: 0.46,
      intensity: 1.55,
      shadowStrength: 0.55,
    });
    this.dynamicLights.push(this.sun);

    // A broad warm fill from the sun's direction, so the scene is not lit by a
    // single hard source with nothing filling the shadows.
    this.dynamicLights.push(
      createLight({
        type: LightType.Point,
        x: ARES_SUN_WORLD.x * 0.4,
        y: ARES_SUN_WORLD.y * 0.4,
        radius: 42,
        r: 1.0,
        g: 0.66,
        b: 0.42,
        intensity: 0.85,
        shadowStrength: 0,
        falloffExponent: 1.4,
      }),
    );

    this.camera.snapTo(0, 0.5);
    this.camera.viewHeightMetres = 11.25;
  }

  fixedUpdate(dt: number, _simTime: number): void {
    this.time += dt;
  }

  render(_alpha: number, _dt: number, unscaledDt: number): void {
    this.camera.update(unscaledDt);

    this.lights.clear();
    for (let i = 0; i < this.dynamicLights.length; i++) {
      const light = this.dynamicLights[i]!;
      // A slow flicker on the practical lights, so nothing is ever perfectly
      // static. Stillness is what makes a scene read as a screenshot.
      if (light.type === LightType.Point && light.b > 0.9) {
        const flicker =
          0.9 +
          Math.sin(this.time * 3.1 + i * 2.3) * 0.05 +
          driftNoise.noise2(this.time * 1.9, i * 13) * 0.05;
        light.intensity = 1.25 * flicker;
      }
      this.lights.add(light);
    }

    this.pipeline.render({
      camera: this.camera,
      atmosphere: this.atmosphere,
      lights: this.lights,
      timeSeconds: this.time,
      drawGeometry: (batch) => this.drawGeometry(batch),
      drawOccluders: (batch) => this.drawOccluders(batch),
    });

    if (this.loop) {
      this.pipeline.updateDynamicResolution(this.loop.timings.frameMs, 1000 / 60);
    }
  }

  private drawGeometry(batch: SpriteBatch): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    // Back to front: there is no depth buffer, so submission order is the only
    // thing determining occlusion. Background layers first, props next, and
    // foreground framing last so it silhouettes over everything.
    this.parallax.drawBackground(batch, this.layers, this.time);

    batch.setBlend(BlendMode.Premultiplied);
    const white = packColor(1, 1, 1, 1);

    const sorted = [...this.props].sort((a, b) => b.depth - a.depth);
    for (const prop of sorted) {
      const entry = this.atlas.get(prop.sprite);
      const parallax = this.camera.parallaxFactor(prop.depth);
      const offsetX = this.camera.x * (1 - parallax);
      const offsetY = this.camera.y * (1 - parallax);

      const color = prop.tint
        ? packColor(prop.tint[0], prop.tint[1], prop.tint[2], 1)
        : white;

      batch.draw(
        prop.x + offsetX,
        prop.y + offsetY,
        prop.width,
        prop.height,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        prop.depth,
        color,
        packMaterial(prop.emissive, 0.5, 0.5, 0),
        prop.rotation,
      );
    }

    this.drawMotes(batch);

    batch.setBlend(BlendMode.Premultiplied);
    this.parallax.drawForeground(batch, this.layers, this.time);
  }

  /**
   * Airborne dust.
   *
   * Advected along a curl-noise field so the air swirls rather than sliding in
   * straight lines, drawn additively at a range of depths. Cheap, and one of
   * the strongest available cues that the scene occupies real space.
   */
  private drawMotes(batch: SpriteBatch): void {
    const entry = this.atlas.get('mote');
    batch.setBlend(BlendMode.Additive);
    const material = packMaterial(1, 1, 0, 0);

    const visible = this.camera.getVisibleBounds(3);

    for (const mote of this.motes) {
      const drift = driftNoise.noise2(mote.x * 0.09 + this.time * 0.07, mote.y * 0.09);
      const bob = Math.sin(this.time * mote.speed + mote.phase) * 0.3;

      const x = mote.x + this.time * mote.speed * 0.42 + drift * 1.1;
      const y = mote.y + bob + drift * 0.5;

      const parallax = this.camera.parallaxFactor(mote.depth);
      const offsetX = this.camera.x * (1 - parallax);
      const offsetY = this.camera.y * (1 - parallax);

      // Wrap around the camera so the field is effectively infinite without
      // needing to simulate motes that are nowhere near the view.
      const span = 80;
      let wrappedX = x;
      const relativeX = x + offsetX - this.camera.x;
      if (relativeX < -span / 2) wrappedX += span;
      else if (relativeX > span / 2) wrappedX -= span;

      const finalX = wrappedX + offsetX;
      const finalY = y + offsetY;
      if (finalX < visible.minX || finalX > visible.maxX) continue;

      const twinkle = 0.55 + Math.sin(this.time * 2.1 + mote.phase) * 0.45;
      const alpha = clamp01((mote.brightness * twinkle) / (1 + mote.depth * 0.4));

      // Warm sunlit dust versus cooler shadowed ash.
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

    for (const prop of this.props) {
      if (!prop.castsShadow) continue;
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
        prop.depth,
        white,
        material,
        prop.rotation,
      );
    }

    // The foreground silhouette is the main god-ray occluder: shafts breaking
    // over the top of it is the effect the whole layer exists to produce.
    const foreground = this.layers.find((layer) => layer.sprite === 'ares.foreground');
    if (foreground) this.parallax.draw(batch, foreground, this.time);
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
      props: this.props.length,
      motes: this.motes.length,
      layers: this.layers.length,
      renderWidth: width,
      renderHeight: height,
      simMs: this.loop?.timings.simMs ?? 0,
      renderMs: this.loop?.timings.renderMs ?? 0,
      frameMs: this.loop?.timings.frameMs ?? 0,
    };
  }

  get elapsed(): number {
    return this.time;
  }
}
