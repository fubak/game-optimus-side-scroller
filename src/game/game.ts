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
import { ARES_SUN_WORLD } from '../world/biomes/ares.ts';
import { BIOMES, BiomeId, allBiomeAtlasSources, type Biome } from '../world/biomes/index.ts';
import type { RoomDefinition } from '../world/rooms/ares-approach.ts';
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
import { Hud } from '../ui/hud.ts';
import { clamp01 } from '../core/math/scalar.ts';

const driftNoise = new NoiseField(0x4d51);

export class Game {
  readonly camera = new Camera();
  readonly lights = new LightList();
  readonly physics = new PhysicsWorld();
  atmosphere: Atmosphere = BIOMES[BiomeId.Ares].atmosphere();
  private biome: Biome = BIOMES[BiomeId.Ares];

  private atlas!: Atlas;
  private parallax!: ParallaxRenderer;
  private layers: ParallaxLayer[] = [];
  private room!: RoomDefinition;
  private loop: GameLoop | null = null;

  player!: PlayerController;
  animator!: OptimusAnimator;
  private optimusRenderer!: OptimusRenderer;
  private hud!: Hud;

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

  // --- Death and respawn ---------------------------------------------------
  /**
   * Last position the player stood safely on solid ground.
   *
   * Respawning here rather than at the room's start is the difference between
   * a fall costing a moment and a fall costing the whole run.
   */
  private checkpointX = 0;
  private checkpointY = 0;
  /** Seconds spent grounded and stable, before a position is trusted. */
  private groundedTime = 0;
  /** Counts respawns, surfaced in stats so a soft-lock cannot pass unnoticed. */
  respawnCount = 0;
  /** Drives the respawn fade, 1 immediately after death down to 0. */
  private respawnFade = 0;

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
    // Every biome's art is baked into one atlas at load, so switching biomes
    // costs no texture upload and can be seamless.
    this.atlas = new Atlas(
      this.device,
      [...buildCoreAtlasSources(), ...allBiomeAtlasSources(), ...buildOptimusAtlasSources()],
      4096,
    );
    this.parallax = new ParallaxRenderer(this.atlas, this.camera);
    this.layers = this.biome.layers();
    this.room = this.biome.room();

    this.buildCollision();
    this.buildLights();
    this.buildAmbientDust();

    this.animator = new OptimusAnimator();
    this.optimusRenderer = new OptimusRenderer(this.atlas, this.animator.skeleton);
    this.hud = new Hud(this.atlas);
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

    this.spawnEncounters();

    this.checkpointX = this.room.spawn.x;
    this.checkpointY = this.room.spawn.y;

    this.initAudio();

    this.camera.setBounds(this.room.bounds);
    this.camera.viewHeightMetres = 9.6;
    this.camera.snapTo(this.player.feetX, this.player.feetY - 1.4);
  }

  /**
   * Places enemies along the current room's route.
   *
   * Posts are derived from the room's own platforms rather than hardcoded, so a
   * biome switch does not need a parallel table that can fall out of sync with
   * the level. Hover height is relative to the floor each drone patrols: an
   * earlier hardcoded height put them 2.5 m above the player's strike zone,
   * where they could attack but could not be attacked back.
   */
  private spawnEncounters(): void {
    /** Keeps drones inside the player's melee box. */
    const hoverHeight = 1.15;

    // Pick the widest platforms, which are the ones with room to fight on.
    const candidates = this.room.platforms
      .filter((platform) => platform.width >= 9)
      .sort((a, b) => a.x - b.x);

    let id = 1;
    for (const platform of candidates) {
      const surfaceY = platform.y - platform.height / 2;
      // Set back from the edges, so a fight cannot start on a lip.
      const x = platform.x + platform.width * 0.12;
      const range = Math.min(platform.width * 0.22, 3.4);
      const drone = new Drone(id++, x, surfaceY - hoverHeight, range, this.enemyRng);
      this.enemies.push(drone);
      this.combat.registerHurtbox(drone.hurtbox);
      if (id > 5) break;
    }
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
    const sun = this.biome;
    this.dynamicLights.push(
      createLight({
        type: LightType.Directional,
        angle: sun.sunAngle,
        r: sun.sunColor[0],
        g: sun.sunColor[1],
        b: sun.sunColor[2],
        intensity: sun.sunIntensity,
        shadowStrength: sun.sunShadow,
      }),
    );
    this.lightFlicker.push(0);
    this.baseIntensity.push(sun.sunIntensity);

    // A broad, shadowless fill from the key light's direction, so an exterior
    // is not lit by one hard source with nothing filling its shadows. Interiors
    // declare no fill: there, all the light is practical.
    const fill = this.biome.fill;
    if (fill) {
      this.dynamicLights.push(
        createLight({
          type: LightType.Point,
          x: ARES_SUN_WORLD.x * 0.4,
          y: ARES_SUN_WORLD.y * 0.4,
          radius: fill.radius,
          r: fill.color[0],
          g: fill.color[1],
          b: fill.color[2],
          intensity: fill.intensity,
          shadowStrength: 0,
          falloffExponent: 1.4,
        }),
      );
      this.lightFlicker.push(0);
      this.baseIntensity.push(fill.intensity);
    }

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
      warm: this.biome.dustWarm,
      cool: this.biome.dustCool,
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

    this.updateCheckpointAndDeath(dt);

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
   * Tracks a safe checkpoint and handles falling out of the world.
   *
   * Without this a fall into a gap is unrecoverable: the character keeps
   * accelerating downward for ever while the camera sits pinned at its lower
   * bound, and the game silently soft-locks with no death, no respawn, and no
   * indication that anything has gone wrong.
   */
  private updateCheckpointAndDeath(dt: number): void {
    const player = this.player;

    // Only trust a position the player has stood on steadily. Recording the
    // instant they touch anything would happily checkpoint the very ledge they
    // are about to slip off.
    if (player.grounded && Math.abs(player.velocityY) < 0.5) {
      this.groundedTime += dt;
      if (this.groundedTime > 0.35) {
        this.checkpointX = player.feetX;
        this.checkpointY = player.feetY;
      }
    } else {
      this.groundedTime = 0;
    }

    this.respawnFade = Math.max(0, this.respawnFade - dt * 1.15);

    // The kill plane sits below the room, not at its edge, so a deep jump near
    // the lower bound is not punished.
    const killY = this.room.bounds.maxY + 6;
    if (player.feetY > killY || this.playerHealth <= 0) {
      this.respawn();
    }
  }

  /** Returns the player to the last safe checkpoint. */
  private respawn(): void {
    this.respawnCount++;
    this.respawnFade = 1;

    this.player.teleport(this.checkpointX, this.checkpointY);
    this.player.interruptAttack();
    this.animator.reset();
    this.camera.snapTo(this.checkpointX, this.checkpointY - 1.15);

    // A fall is a mistake, not a run-ender: restore enough health to continue,
    // without making falling free.
    this.playerHealth = Math.max(this.playerHealth, 45);
    this.playerIFrames = 1.2;

    this.particles.burstDust(this.checkpointX, this.checkpointY, 0.8, [1.0, 0.74, 0.5]);
    this.sfx?.land(12);
    this.camera.addTrauma(0.3);
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
        knockbackX: player.facing * (heavy ? 14 : 8.5),
        knockbackY: heavy ? -5.0 : -2.6,
        // A heavier blow freezes the world for longer, which is most of what
        // makes it feel heavier.
        hitstop: heavy ? 0.19 : 0.085,
        trauma: heavy ? 0.5 : 0.26,
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

  /**
   * @param dt          Scaled seconds — zero during hitstop.
   * @param unscaledDt  Real seconds, unaffected by hitstop or slow motion.
   *
   * The split matters. Hitstop exists to *stop the character*, so the rig must
   * advance on scaled time; running it on unscaled time froze the simulation
   * while the animation played straight through, which meant the freeze was
   * completely invisible and every hit felt weightless. Particles, trails,
   * camera shake, and the HUD stay on unscaled time so impact effects keep
   * playing during the freeze, which is what makes it read as impact rather
   * than as a dropped frame.
   */
  render(_alpha: number, dt: number, unscaledDt: number): void {
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
    this.animator.update(animationInput, dt, player.feetX, player.feetY);

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

    this.hud.update(this.playerHealth / 100, unscaledDt);

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
      drawUI: (batch) => {
        this.hud.draw(batch, this.camera, this.playerHealth / 100);
        this.drawRespawnFade(batch);
      },
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
  private get sunAngle(): number {
    return this.biome.sunAngle;
  }

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

  /**
   * Draws platforms by *tiling* their texture rather than stretching it.
   *
   * A 30 m floor drawn as a single quad stretches a 512 px texture across the
   * whole span, which destroys the surface detail and leaves the slab reading
   * as a flat rectangle of smeared dirt. Tiling at a fixed world size keeps
   * texel density constant no matter how long a platform is, so a short ledge
   * and a long floor are made of visibly the same material.
   *
   * The tile is mirrored on alternate columns. That doubles the apparent period
   * of the pattern for free, which is what stops a long run of ground from
   * showing an obvious repeat.
   */
  private drawPlatforms(batch: SpriteBatch): void {
    const white = packColor(1, 1, 1, 1);
    const material = packMaterial(0, 0.5, 0.2, 0);
    const visible = this.camera.getVisibleBounds(4);

    /** World width of one texture repeat, in metres. */
    const TILE_WIDTH = 7.5;

    for (const platform of this.room.platforms) {
      const left = platform.x - platform.width / 2;
      const right = platform.x + platform.width / 2;
      if (right < visible.minX || left > visible.maxX) continue;

      const entry = this.atlas.get(platform.sprite);

      // Thin ledges get a single stretched quad: they are shorter than a tile,
      // and tiling them would crop the lit top edge that makes them readable.
      if (platform.width <= TILE_WIDTH * 1.1) {
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
        continue;
      }

      const tiles = Math.ceil(platform.width / TILE_WIDTH);
      const tileWidth = platform.width / tiles;

      for (let i = 0; i < tiles; i++) {
        const x = left + tileWidth * (i + 0.5);
        // Cull per tile, so a long floor only draws the part in view.
        if (x + tileWidth / 2 < visible.minX || x - tileWidth / 2 > visible.maxX) continue;

        // Mirror alternate tiles to double the apparent period.
        const flip = i % 2 === 1;
        batch.draw(
          x,
          platform.y,
          tileWidth,
          platform.height,
          flip ? entry.u1 : entry.u0,
          entry.v0,
          flip ? entry.u0 : entry.u1,
          entry.v1,
          Depth.Playfield,
          white,
          material,
          0,
        );
      }
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
   * scaled the normal, material, and depth attachments - flipping the normals
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
     * air above the platform, where there is no geometry to darken.
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
        packColor(density, density, density, density),
        material,
        0,
      );
    };

    for (const prop of this.room.props) {
      if (!prop.castsShadow) continue;
      if (prop.x < visible.minX || prop.x > visible.maxX) continue;
      blob(prop.x + 0.06, prop.y + prop.height / 2, prop.width * 2.3, 1.0);
    }

    // Enemies are grounded to the world too, even while hovering.
    for (const drone of this.enemies) {
      if (drone.x < visible.minX || drone.x > visible.maxX) continue;
      const surface = this.physics.surfaceHeightAt(drone.x, drone.y, 8);
      if (!surface.found) continue;
      const height = surface.y - drone.y;
      const fade = clamp01(1 - height / 4.5);
      if (fade <= 0.02) continue;
      blob(drone.x, surface.y, 1.5 * (1 + height * 0.2), fade * fade * 0.8);
    }

    const player = this.player;
    const heightAboveGround = Math.max(0, player.groundY - player.feetY);
    const fade = clamp01(1 - heightAboveGround / 2.2);
    if (fade > 0.02) {
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

  /**
   * A full-screen wipe covering a respawn.
   *
   * Without it the teleport is visible as a hard cut: the camera jumps, the
   * character appears somewhere else, and it reads as a glitch rather than a
   * mechanic. A fast fade out and a slower fade in is the standard solution
   * because it hides the discontinuity *and* gives the player a moment to
   * register that something happened.
   */
  private drawRespawnFade(batch: SpriteBatch): void {
    if (this.respawnFade <= 0.002) return;

    const fill = this.atlas.get('barFill');
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Alpha);

    // Squared, so the screen clears quickly and lingers dark only briefly.
    const alpha = this.respawnFade * this.respawnFade;

    batch.draw(
      this.camera.x,
      this.camera.y,
      this.camera.viewWidthMetres * 1.1,
      this.camera.viewHeightMetres * 1.1,
      fill.u0,
      fill.v0,
      fill.u1,
      fill.v1,
      0,
      // Not pure black: a very dark red keeps it inside the biome's palette.
      packColor(0.04 * alpha, 0.012 * alpha, 0.01 * alpha, alpha),
      packMaterial(0, 1, 0, 0),
      0,
    );

    batch.setBlend(BlendMode.Premultiplied);
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

  /**
   * Switches biome, rebuilding the world from its definition.
   *
   * The atlas already holds every biome's art, so this is a change of layer
   * list, atmosphere, room geometry, and light rig with no texture work at all.
   */
  setBiome(id: BiomeId): void {
    this.biome = BIOMES[id];
    this.layers = this.biome.layers();
    this.atmosphere = this.biome.atmosphere();
    this.room = this.biome.room();

    this.buildCollision();

    this.dynamicLights.length = 0;
    this.lightFlicker.length = 0;
    this.baseIntensity.length = 0;
    this.buildLights();

    // Rebuild the encounter set for the new room.
    for (const drone of this.enemies) this.combat.removeHurtbox(drone.id);
    this.enemies.length = 0;
    this.previousDroneStates.clear();
    this.spawnEncounters();

    this.particles.clear();
    this.buildAmbientDust();

    this.checkpointX = this.room.spawn.x;
    this.checkpointY = this.room.spawn.y;
    this.playerHealth = 100;
    this.respawnCount = 0;

    this.player.teleport(this.room.spawn.x, this.room.spawn.y);
    this.animator.reset();
    this.camera.setBounds(this.room.bounds);
    this.camera.snapTo(this.room.spawn.x, this.room.spawn.y - 1.15);
    this.autopilot?.reset();
  }

  get currentBiome(): BiomeId {
    return this.biome.id;
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
      respawns: this.respawnCount,
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
