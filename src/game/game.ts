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
import { Depth } from '../core/config.ts';
import { PhysicsWorld } from './physics.ts';
import { PlayerController } from './player/controller.ts';
import { Autopilot, type AutopilotOptions } from './autopilot.ts';
import { OptimusAnimator, type AnimationInput } from './player/animator.ts';
import { OptimusRenderer } from './player/renderer.ts';
import { input } from '../core/input.ts';
import type { GameLoop } from '../core/loop.ts';
import { NoiseField } from '../core/math/noise.ts';
import { ParticleSystem, ParticleKind } from '../fx/particles.ts';
import type { InstancedQuads } from '../gfx/instanced.ts';
import { BUDGETS } from '../core/config.ts';
import { CombatSystem, Faction, type Hurtbox } from './combat.ts';
import { Drone, DRONE, DroneState } from './enemies/drone.ts';
import { Trail, TRAIL_STYLES } from '../fx/trails.ts';
import { Rng } from '../core/rng.ts';
import { aabb } from '../core/math/aabb.ts';
import { MOVEMENT } from './player/controller.ts';
import { AudioEngine } from '../audio/engine.ts';
import { Sfx } from '../audio/sfx.ts';
import { Ambience } from '../audio/ambience.ts';
import { DroneState as DS } from './enemies/drone.ts';
import { clamp01 } from '../core/math/scalar.ts';

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

  /**
   * All airborne particulate.
   *
   * One pooled system drawn with a single instanced call, rather than a few
   * hundred individual quads. Density is most of what separates a scene that
   * feels like a place from one that feels like a diagram.
   */
  readonly particles = new ParticleSystem(BUDGETS.maxLiveParticles, 0xfa11);
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
  /** Throttles the running dust trail so it does not flood the pool. */
  private runDustCooldown = 0;

  // --- Combat -------------------------------------------------------------
  readonly combat = new CombatSystem();
  readonly enemies: Drone[] = [];
  private playerHurtbox!: Hurtbox;
  /** Live melee hitbox activation, or -1. */
  private activeHitbox = -1;
  /** Trail on the attacking hand. */
  private readonly slashTrail = new Trail(TRAIL_STYLES.slash, 20);
  private readonly heavyTrail = new Trail(TRAIL_STYLES.heavySlash, 24);
  private readonly dashTrail = new Trail(TRAIL_STYLES.dash, 18);
  /** Seconds of player invulnerability remaining after taking a hit. */
  private playerIFrames = 0;
  playerHealth = 100;
  private readonly enemyRng = new Rng(0xd40e);

  // --- Audio ---------------------------------------------------------------
  /**
   * Audio is optional.
   *
   * Constructing an AudioContext throws in some headless configurations, and
   * the capture harness has no audio device at all. A game that refuses to boot
   * because it cannot make a sound is a worse outcome than a silent one, so
   * every audio call is guarded.
   */
  private audio: AudioEngine | null = null;
  private sfx: Sfx | null = null;
  private ambience: Ambience | null = null;
  /** Distance travelled since the last footstep, in metres. */
  private stepDistance = 0;
  /** Previous drone states, so transitions can be detected for audio cues. */
  private readonly previousDroneStates = new Map<number, number>();

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

    // --- Combat setup -----------------------------------------------------
    this.playerHurtbox = {
      id: 0,
      faction: Faction.Player,
      box: aabb(this.player.box.x, this.player.box.y, this.player.box.hw, this.player.box.hh),
      invulnerable: false,
      alive: true,
    };
    this.combat.registerHurtbox(this.playerHurtbox);

    // Drones posted along the route, spaced so each is met individually.
    //
    // Hover height is set relative to the floor each one patrols, not to world
    // zero. The first pass put them 2.5 m above the player's strike zone, where
    // they could attack but could not be attacked back.
    const posts: [number, number, number][] = [
      // [x, floor surface Y, patrol range]
      [-4.5, -1.1, 2.6],
      [14.0, -1.4, 3.0],
      [27.5, -2.6, 2.2],
      [68.0, -8.2, 3.4],
    ];
    /** Hover height above the floor, in metres. Keeps drones inside the melee box. */
    const hoverHeight = 1.15;
    for (let i = 0; i < posts.length; i++) {
      const [x, floorY, range] = posts[i]!;
      const drone = new Drone(i + 1, x, floorY - hoverHeight, range, this.enemyRng);
      this.enemies.push(drone);
      this.combat.registerHurtbox(drone.hurtbox);
    }

    this.initAudio();

    this.camera.setBounds(this.room.bounds);
    this.camera.viewHeightMetres = 9.6;
    this.camera.snapTo(this.player.feetX, this.player.feetY - 1.4);
  }

  /** Builds the audio graph, tolerating environments that have no audio. */
  private initAudio(): void {
    try {
      this.audio = new AudioEngine();
      this.sfx = new Sfx(this.audio);
      this.ambience = new Ambience(this.audio);
    } catch {
      this.audio = null;
      this.sfx = null;
      this.ambience = null;
    }
  }

  /** Resumes audio. Must be called from a user gesture. */
  async unlockAudio(): Promise<void> {
    if (!this.audio) return;
    await this.audio.unlock();
    this.ambience?.start();
  }

  get audioEngine(): AudioEngine | null {
    return this.audio;
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
    // Seeded around the spawn point; the field wraps around the camera, so it
    // is effectively infinite from here on.
    this.particles.seedAmbient(3200, this.room.spawn.x, this.room.spawn.y - 4, 70, 26, {
      warm: [1.0, 0.72, 0.44],
      cool: [0.58, 0.54, 0.72],
    });
    this.particles.windX = 0.62;
    this.particles.windY = -0.05;
  }

  fixedUpdate(dt: number, simTime: number): void {
    this.time += dt;

    // The autopilot drives input rather than replacing the controller, so a
    // recorded run exercises exactly the same movement code a player would.
    if (this.autopilot && this.autopilotOptions) {
      // Feed live hostile positions in, so the navigator fights rather than
      // running past everything.
      this.autopilotOptions.threats = this.enemies
        .filter((drone) => drone.state !== DroneState.Dying)
        .map((drone) => ({ x: drone.x, y: drone.y }));
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

    // --- Combat ------------------------------------------------------------
    this.playerIFrames = Math.max(0, this.playerIFrames - dt);
    this.playerHurtbox.invulnerable = this.playerIFrames > 0 || this.player.invulnerable;
    this.playerHurtbox.box.x = this.player.box.x;
    this.playerHurtbox.box.y = this.player.box.y;

    this.updateMeleeHitbox();

    for (const drone of this.enemies) {
      drone.update(dt, this.player.feetX, this.player.feetY);
    }

    this.combat.resolve(dt);
    this.applyHitEvents();
    this.applyContactDamage();

    // Retire fully dissolved drones.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i]!.alive) {
        this.combat.removeHurtbox(this.enemies[i]!.id);
        this.enemies.splice(i, 1);
      }
    }

    this.particles.update(
      dt,
      this.camera.x,
      this.camera.y,
      this.camera.viewWidthMetres,
      this.camera.viewHeightMetres,
    );

    // Landing shakes the camera in proportion to the real impact speed, so a
    // short hop and a long drop feel genuinely different.
    if (this.player.landedThisStep > 3) {
      const strength = clamp01(this.player.landedThisStep / 22);
      this.camera.addTrauma(strength * 0.45);
      this.sfx?.land(this.player.landedThisStep);
      // Dust kicked outward along the surface, plus chips of the surface
      // itself on a hard enough impact.
      this.particles.burstDust(this.player.feetX, this.player.feetY, strength, [1.0, 0.72, 0.46]);
      if (strength > 0.5) {
        this.particles.burstDebris(this.player.feetX, this.player.feetY, strength * 0.7, [0.55, 0.34, 0.24]);
      }
    }
    if (this.player.dashedThisStep) {
      this.sfx?.dash();
      this.camera.addTrauma(0.12);
      // The dash vents along the character's own cyan.
      this.particles.burstSparks(
        this.player.feetX - this.player.facing * 0.3,
        this.player.feetY - 0.9,
        -this.player.facing,
        -0.15,
        0.55,
        [0.30, 0.95, 1.0],
      );
    }

    if (this.player.jumpedThisStep) this.sfx?.jump();
    if (this.player.attackStartedThisStep >= 0) {
      this.sfx?.attackSwing(this.player.attackStartedThisStep);
    }

    // Footsteps are driven by distance travelled, not by a timer, so the
    // cadence automatically matches the gait at any speed.
    if (this.player.grounded && this.player.speed > 0.6) {
      this.stepDistance += this.player.speed * dt;
      const stride = this.player.speed > 5 ? 1.45 : 1.05;
      if (this.stepDistance >= stride) {
        this.stepDistance = 0;
        this.sfx?.footstep(this.player.speed);
      }
    } else {
      this.stepDistance = 0;
    }

    // Drone state transitions drive their audio cues.
    for (const drone of this.enemies) {
      const previous = this.previousDroneStates.get(drone.id);
      if (previous !== drone.state) {
        if (drone.state === DS.Alert) this.sfx?.droneAlert();
        else if (drone.state === DS.Lunge) this.sfx?.droneLunge();
        this.previousDroneStates.set(drone.id, drone.state);
      }
    }

    // Musical intensity follows how much danger is actually nearby.
    if (this.ambience) {
      let threat = 0;
      for (const drone of this.enemies) {
        if (drone.state === DS.Dying) continue;
        const distance = Math.hypot(drone.x - this.player.feetX, drone.y - this.player.feetY);
        threat = Math.max(threat, clamp01(1 - distance / 11));
      }
      this.ambience.setIntensity(threat);
      this.ambience.update(dt);
    }

    // Running kicks a thin trail of dust off the surface.
    if (this.player.grounded && this.player.speed > 4.5 && this.runDustCooldown <= 0) {
      this.particles.burstDust(
        this.player.feetX - this.player.facing * 0.2,
        this.player.feetY,
        0.14,
        [1.0, 0.74, 0.5],
      );
      this.runDustCooldown = 0.075;
    }
    this.runDustCooldown -= dt;
  }

  /**
   * Opens, moves, and closes the melee hitbox in step with the animation.
   *
   * The box is placed ahead of the character rather than tracked to the hand
   * bone. A hitbox welded to the hand follows the animation so literally that
   * it becomes unpredictable to aim; a stable box in front of the character is
   * what players actually expect from a swing.
   */
  private updateMeleeHitbox(): void {
    const player = this.player;

    if (player.hitboxOpenedThisStep >= 0) {
      const step = player.hitboxOpenedThisStep;
      const heavy = step === 2;
      const reach = heavy ? 1.55 : 1.25;

      this.activeHitbox = this.combat.spawnHitbox({
        faction: Faction.Player,
        x: player.feetX + player.facing * reach * 0.55,
        y: player.feetY - 0.95,
        halfWidth: reach * 0.5,
        halfHeight: heavy ? 0.72 : 0.58,
        damage: MOVEMENT.attackDamage[step]!,
        knockbackX: player.facing * (heavy ? 9.5 : 5.5),
        knockbackY: heavy ? -3.4 : -1.8,
        // A heavier blow freezes the world for longer, which is most of what
        // makes it feel heavier.
        hitstop: heavy ? 0.135 : 0.055,
        trauma: heavy ? 0.42 : 0.18,
        duration: 0.28,
        multiHit: heavy,
      });

      (heavy ? this.heavyTrail : this.slashTrail).start();
    }

    if (this.activeHitbox >= 0 && player.attackStep >= 0) {
      this.combat.moveHitbox(
        this.activeHitbox,
        player.feetX + player.facing * (player.attackStep === 2 ? 0.85 : 0.7),
        player.feetY - 0.95,
      );
    }

    if (player.hitboxClosedThisStep) {
      if (this.activeHitbox >= 0) this.combat.cancelHitbox(this.activeHitbox);
      this.activeHitbox = -1;
      this.slashTrail.stop();
      this.heavyTrail.stop();
    }
  }

  /**
   * Turns hit events into damage, hitstop, shake, and particles.
   *
   * All of it is driven from one place so the effects cannot drift out of sync
   * with each other, and hitstop is applied once for the frame rather than once
   * per simultaneous hit.
   */
  private applyHitEvents(): void {
    for (const event of this.combat.events) {
      if (event.attacker === Faction.Player) {
        const drone = this.enemies.find((d) => d.id === event.targetId);
        if (!drone) continue;

        const killed = drone.takeHit(event.damage, event.knockbackX, event.knockbackY);
        this.sfx?.impact(event.damage);
        if (killed) this.sfx?.enemyDeath();

        // Sparks fly along the direction force was transferred.
        this.particles.burstSparks(
          event.x,
          event.y,
          event.normalX,
          event.normalY - 0.3,
          killed ? 1.3 : 0.75,
          [1.0, 0.86, 0.55],
        );
        this.particles.burstDebris(event.x, event.y, killed ? 1.0 : 0.4, [0.42, 0.40, 0.42]);

        if (killed) {
          // A death is a bigger event than a hit, and should read that way.
          this.particles.burstSparks(event.x, event.y, 0, -1, 1.6, [0.30, 0.95, 1.0]);
          this.particles.burstDust(event.x, event.y, 0.9, [0.7, 0.65, 0.7]);
          this.camera.addTrauma(0.4);
        }
      } else {
        // The player was hit.
        if (this.playerIFrames > 0) continue;
        this.playerHealth = Math.max(0, this.playerHealth - event.damage);
        this.playerIFrames = 0.85;
        this.sfx?.playerHurt();
        this.player.interruptAttack();
        this.animator.triggerHitReact();
        this.particles.burstSparks(event.x, event.y, event.normalX, -0.5, 0.9, [1.0, 0.5, 0.35]);
      }
    }

    const hitstop = this.combat.peakHitstop;
    if (hitstop > 0) this.loop?.hitstop(hitstop);

    const trauma = this.combat.peakTrauma;
    if (trauma > 0) this.camera.addTrauma(trauma);
  }

  /** A lunging drone damages the player on contact with its body. */
  private applyContactDamage(): void {
    if (this.playerHurtbox.invulnerable) return;

    for (const drone of this.enemies) {
      if (!drone.isDangerous) continue;
      const dx = Math.abs(drone.x - this.player.box.x);
      const dy = Math.abs(drone.y - this.player.box.y);
      if (dx > drone.box.hw + this.player.box.hw) continue;
      if (dy > drone.box.hh + this.player.box.hh) continue;

      this.playerHealth = Math.max(0, this.playerHealth - DRONE.contactDamage);
      this.playerIFrames = 0.85;
      this.sfx?.playerHurt();
      this.player.interruptAttack();
      this.animator.triggerHitReact();
      this.camera.addTrauma(0.3);
      this.loop?.hitstop(0.06);
      this.particles.burstSparks(
        this.player.feetX,
        this.player.feetY - 0.9,
        Math.sign(this.player.box.x - drone.x),
        -0.4,
        0.9,
        [1.0, 0.5, 0.35],
      );
      break;
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
      attackStep: player.attackStep,
      attackTime: player.attackTime,
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

    // Trails sample at render rate, so they stay smooth at any refresh.
    const hand = this.animator.bones.handNear;
    const world = this.animator.skeleton.world;
    this.slashTrail.sample(world.worldX[hand]!, world.worldY[hand]!);
    this.heavyTrail.sample(world.worldX[hand]!, world.worldY[hand]!);
    this.slashTrail.update(unscaledDt);
    this.heavyTrail.update(unscaledDt);

    if (player.state === 2 /* Dashing */) {
      this.dashTrail.start();
      this.dashTrail.sample(player.feetX, player.feetY - 0.85);
    } else {
      this.dashTrail.stop();
    }
    this.dashTrail.update(unscaledDt);

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
      emitParticles: (quads, submit) => this.emitParticles(quads, submit),
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

    this.drawEnemies(batch);

    this.optimusRenderer.draw(batch, this.animator.skeleton, this.player.facing);

    this.drawTrails(batch);

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
   * Queues every live particle into the shared instance buffer.
   *
   * Split into two submissions: soft round motes for dust and smoke, then
   * stretched streaks for sparks. Two draw calls total, whatever the count.
   */
  private emitParticles(
    quads: InstancedQuads,
    submit: (
      uvRect: [number, number, number, number],
      texture: WebGLTexture,
      stretch: number,
    ) => void,
  ): void {
    const pool = this.particles.pool;
    const mote = this.atlas.get('mote');
    const glow = this.atlas.get('glow');
    const visible = this.camera.getVisibleBounds(3);

    // --- Round particles ---------------------------------------------------
    for (let i = 0; i < pool.count; i++) {
      if (pool.kind[i] === ParticleKind.Spark) continue;

      // Cull against the view, accounting for the layer's parallax offset.
      const parallax = this.camera.parallaxFactor(pool.depth[i]!);
      const x = pool.x[i]! + this.camera.x * (1 - parallax);
      const y = pool.y[i]! + this.camera.y * (1 - parallax);
      if (x < visible.minX || x > visible.maxX || y < visible.minY || y > visible.maxY) continue;

      const alpha = this.particles.alphaAt(i, this.time);
      if (alpha < 0.004) continue;

      quads.push(
        pool.x[i]!,
        pool.y[i]!,
        pool.depth[i]!,
        pool.size[i]!,
        pool.rotation[i]!,
        packColor(pool.r[i]! * alpha, pool.g[i]! * alpha, pool.b[i]! * alpha, alpha),
      );
    }
    submit([mote.u0, mote.v0, mote.u1, mote.v1], this.atlas.textures.albedo.handle, 0);

    // --- Sparks ------------------------------------------------------------
    for (let i = 0; i < pool.count; i++) {
      if (pool.kind[i] !== ParticleKind.Spark) continue;
      const alpha = this.particles.alphaAt(i, this.time);
      if (alpha < 0.004) continue;

      quads.push(
        pool.x[i]!,
        pool.y[i]!,
        pool.depth[i]!,
        pool.size[i]!,
        pool.rotation[i]!,
        packColor(pool.r[i]! * alpha, pool.g[i]! * alpha, pool.b[i]! * alpha, alpha),
      );
    }
    // Stretched along travel, which is what makes a spark read as a streak.
    submit([glow.u0, glow.v0, glow.u1, glow.v1], this.atlas.textures.albedo.handle, 3.2);
  }

  private drawEnemies(batch: SpriteBatch): void {
    const entry = this.atlas.get('drone');
    const visible = this.camera.getVisibleBounds(3);
    batch.setBlend(BlendMode.Premultiplied);

    for (const drone of this.enemies) {
      if (drone.x < visible.minX || drone.x > visible.maxX) continue;

      // Dying drones shrink and fade. A proper noise-threshold dissolve is
      // still to come; this at least reads as destruction rather than a sprite
      // being deleted.
      const scale = 1 - drone.dissolve * 0.45;
      const alpha = 1 - drone.dissolve;
      if (alpha <= 0.01) continue;

      // The white flash marks the instant of contact.
      const flash = drone.flash;
      const r = (1 - flash) * 1 + flash * 4;
      const tint = packColor(r * alpha, r * alpha, r * alpha, alpha);

      batch.draw(
        drone.x,
        drone.y,
        DRONE.size * scale,
        DRONE.size * scale,
        drone.facing > 0 ? entry.u0 : entry.u1,
        entry.v0,
        drone.facing > 0 ? entry.u1 : entry.u0,
        entry.v1,
        Depth.Playfield,
        tint,
        // Charge drives the optic's emissive, so the telegraph is visible.
        packMaterial(drone.charge * 0.8 + flash, 0.5, 0.6, 0),
        drone.state === DroneState.Dying ? drone.dissolve * 1.6 : 0,
      );
    }
  }

  private drawTrails(batch: SpriteBatch): void {
    const glow = this.atlas.get('glow');
    this.dashTrail.draw(batch, glow);
    this.slashTrail.draw(batch, glow);
    this.heavyTrail.draw(batch, glow);
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
      particles: this.particles.count,
      enemies: this.enemies.length,
      playerHealth: this.playerHealth,
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
