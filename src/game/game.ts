/**
 * The game shell.
 *
 * Owns the world, drives the simulation, and assembles the frame request the
 * pipeline consumes. Currently hosts a test scene that exercises every stage of
 * the renderer — tiled ground, bevelled mechanical props, a hard directional
 * sun, coloured point lights with shadows, and drifting dust — so the pipeline
 * can be validated before the real world content lands on top of it.
 */

import { Device } from '../gfx/device.ts';
import { Pipeline, DEFAULT_ATMOSPHERE, type Atmosphere } from '../render/pipeline.ts';
import { LightList, createLight, LightType, type Light } from '../render/lights.ts';
import { Camera } from '../scene/camera.ts';
import { Atlas } from '../art/atlas.ts';
import { buildCoreAtlasSources } from '../art/library.ts';
import { SpriteBatch, packColor, packMaterial } from '../gfx/batch.ts';
import { BlendMode } from '../gfx/device.ts';
import { fxRng } from '../core/rng.ts';
import { Depth } from '../core/config.ts';
import type { GameLoop } from '../core/loop.ts';
import { NoiseField } from '../core/math/noise.ts';

interface Prop {
  x: number;
  y: number;
  width: number;
  height: number;
  sprite: string;
  depth: number;
  rotation: number;
  emissive: number;
}

interface Mote {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  depth: number;
  brightness: number;
}

const driftNoise = new NoiseField(0x4d51);

export class Game {
  readonly camera = new Camera();
  readonly lights = new LightList();
  atmosphere: Atmosphere = { ...DEFAULT_ATMOSPHERE };

  private atlas!: Atlas;
  private loop: GameLoop | null = null;

  private readonly props: Prop[] = [];
  private readonly motes: Mote[] = [];
  private readonly dynamicLights: Light[] = [];

  /** Seconds of simulated time; drives all ambient animation. */
  private time = 0;

  constructor(
    readonly device: Device,
    readonly pipeline: Pipeline,
  ) {}

  async load(): Promise<void> {
    this.atlas = new Atlas(this.device, buildCoreAtlasSources(), 2048);
    this.buildTestScene();
  }

  attachLoop(loop: GameLoop): void {
    this.loop = loop;
  }

  resize(width: number, height: number): void {
    this.camera.setViewport(width, height);
  }

  /**
   * Assembles a scene that deliberately stresses every renderer feature:
   * tiled normal-mapped ground for the lighting, tall occluders for shadows and
   * god rays, emissive strips for bloom, and layered dust for depth.
   */
  private buildTestScene(): void {
    const rng = fxRng;

    // Ground: a run of rock tiles with slight vertical jitter so the top edge
    // is not a perfectly straight line.
    for (let x = -30; x < 30; x++) {
      const variant = Math.abs(x * 7919) % 4;
      this.props.push({
        x: x + 0.5,
        y: 4.5,
        width: 1.02,
        height: 1.02,
        sprite: `rock${variant}`,
        depth: Depth.Playfield,
        rotation: 0,
        emissive: 0,
      });
      for (let y = 1; y < 4; y++) {
        this.props.push({
          x: x + 0.5,
          y: 4.5 + y,
          width: 1.02,
          height: 1.02,
          sprite: `rock${(variant + y) % 4}`,
          depth: Depth.Playfield,
          rotation: 0,
          emissive: 0,
        });
      }
    }

    // Background rock walls at two parallax depths.
    for (let x = -26; x < 26; x += 2) {
      const height = 3 + driftNoise.fbm2(x * 0.2, 0, 3) * 4;
      for (let y = 0; y < height; y++) {
        this.props.push({
          x: x + 1,
          y: 3.5 - y * 2,
          width: 2.1,
          height: 2.1,
          sprite: `rock${Math.abs(x + y) % 4}`,
          depth: Depth.MidParallax,
          rotation: 0,
          emissive: 0,
        });
      }
    }

    // Mechanical props: crates and a lit console, to exercise the bevelled
    // panel language and the emissive path.
    const crateSpots = [-8, -5.5, -3, 2, 5, 9, 12];
    for (const x of crateSpots) {
      const size = 0.8 + rng.next() * 0.5;
      this.props.push({
        x,
        y: 4 - size / 2,
        width: size,
        height: size,
        sprite: 'panel',
        depth: Depth.Playfield,
        rotation: 0,
        emissive: 0,
      });
    }

    const consoleSpots = [-6.5, 3.5, 10.5];
    for (const x of consoleSpots) {
      this.props.push({
        x,
        y: 3.6,
        width: 1.2,
        height: 0.8,
        sprite: 'panelLit',
        depth: Depth.Playfield,
        rotation: 0,
        emissive: 0.85,
      });

      // Each console casts its own cyan pool of light with a real shadow.
      this.dynamicLights.push(
        createLight({
          type: LightType.Point,
          x,
          y: 3.2,
          radius: 6.5,
          r: 0.247,
          g: 0.914,
          b: 1.0,
          intensity: 1.5,
          shadowStrength: 0.85,
          falloffExponent: 2.2,
        }),
      );
    }

    // Drifting atmospheric motes.
    for (let i = 0; i < 260; i++) {
      this.motes.push({
        x: rng.range(-30, 30),
        y: rng.range(-9, 5),
        size: rng.range(0.03, 0.11),
        speed: rng.range(0.25, 1.1),
        phase: rng.range(0, Math.PI * 2),
        depth: rng.range(0, 6),
        brightness: rng.range(0.25, 1),
      });
    }

    // The sun: low, hard, and warm, raking across the scene from the left.
    this.dynamicLights.push(
      createLight({
        type: LightType.Directional,
        angle: -0.42,
        r: 1.0,
        g: 0.76,
        b: 0.52,
        intensity: 1.35,
        shadowStrength: 0.7,
      }),
    );

    this.camera.snapTo(0, 1.5);
    this.camera.viewHeightMetres = 11.25;

    this.atmosphere.godRayX = -18;
    this.atmosphere.godRayY = -10;
  }

  fixedUpdate(dt: number, _simTime: number): void {
    this.time += dt;
  }

  render(_alpha: number, _dt: number, unscaledDt: number): void {
    this.camera.update(unscaledDt);

    this.lights.clear();
    for (const light of this.dynamicLights) this.lights.add(light);

    // Give the console lights a slow flicker so the scene is never static.
    for (let i = 0; i < this.dynamicLights.length; i++) {
      const light = this.dynamicLights[i]!;
      if (light.type !== LightType.Point) continue;
      const flicker = 0.88 + Math.sin(this.time * 3.1 + i * 2.3) * 0.06 + driftNoise.noise2(this.time * 1.7, i * 13) * 0.06;
      light.intensity = 1.5 * flicker;
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

    const white = packColor(1, 1, 1, 1);

    // Depth order matters: furthest first, since there is no depth buffer.
    const sorted = [...this.props].sort((a, b) => b.depth - a.depth);

    for (const prop of sorted) {
      const entry = this.atlas.get(prop.sprite);
      const parallax = this.camera.parallaxFactor(prop.depth);

      // Parallax is applied by shifting geometry against the camera, so a
      // single view matrix can serve every layer.
      const offsetX = this.camera.x * (1 - parallax);
      const offsetY = this.camera.y * (1 - parallax);

      // Distant layers are tinted toward the fog colour and desaturated, which
      // is the aerial-perspective cue the depth metrics check for.
      const depthFade = Math.min(prop.depth / 8, 1);
      const tint = packColor(
        1 - depthFade * 0.35,
        1 - depthFade * 0.42,
        1 - depthFade * 0.4,
        1,
      );

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
        depthFade > 0 ? tint : white,
        packMaterial(prop.emissive, 0.5, 0.5, 0),
        prop.rotation,
      );
    }

    this.drawMotes(batch);
  }

  /**
   * Airborne dust.
   *
   * Motes drift along a curl-noise field rather than in straight lines, so the
   * air reads as genuinely turbulent. Drawn additively at varying depths, they
   * are one of the cheapest and most effective depth cues available.
   */
  private drawMotes(batch: SpriteBatch): void {
    const entry = this.atlas.get('mote');
    batch.setBlend(BlendMode.Additive);

    const material = packMaterial(1, 1, 0, 0);

    for (const mote of this.motes) {
      const drift = driftNoise.noise2(mote.x * 0.1 + this.time * 0.08, mote.y * 0.1);
      const bobY = Math.sin(this.time * mote.speed + mote.phase) * 0.35;
      const x = mote.x + this.time * mote.speed * 0.35 + drift * 0.9;
      const y = mote.y + bobY + drift * 0.4;

      // Wrap so the field is effectively infinite.
      const wrappedX = ((x + 32) % 64) - 32;

      const parallax = this.camera.parallaxFactor(mote.depth);
      const offsetX = this.camera.x * (1 - parallax);
      const offsetY = this.camera.y * (1 - parallax);

      const brightness = mote.brightness * (0.55 + Math.sin(this.time * 2.3 + mote.phase) * 0.45);
      const alpha = brightness / (1 + mote.depth * 0.35);

      batch.draw(
        wrappedX + offsetX,
        y + offsetY,
        mote.size,
        mote.size,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        mote.depth,
        packColor(0.85 * alpha, 0.62 * alpha, 0.45 * alpha, alpha),
        material,
        0,
      );
    }

    batch.setBlend(BlendMode.Premultiplied);
  }

  /**
   * Silhouettes for the shadow and god-ray passes.
   *
   * Only playfield-depth geometry occludes. Background layers must not, or
   * distant hills would cast shadows across the character standing in front of
   * them.
   */
  private drawOccluders(batch: SpriteBatch): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    const white = packColor(1, 1, 1, 1);
    const material = packMaterial(0, 1, 0, 0);

    for (const prop of this.props) {
      if (prop.depth !== Depth.Playfield) continue;
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
  }

  /** Diagnostics surfaced to the perf overlay and the capture harness. */
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
      renderWidth: width,
      renderHeight: height,
      simMs: this.loop?.timings.simMs ?? 0,
      renderMs: this.loop?.timings.renderMs ?? 0,
      frameMs: this.loop?.timings.frameMs ?? 0,
    };
  }

  /** Seconds of simulated time, for the harness. */
  get elapsed(): number {
    return this.time;
  }
}
