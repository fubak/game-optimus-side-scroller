/**
 * The Optimus animation controller.
 *
 * Layers, applied in order:
 *
 * 1. **Base locomotion** — a clip, or a blend between two clips for the
 *    walk/run blendspace. Blendspaces average genuinely similar poses, which is
 *    valid; state *changes* never do.
 * 2. **Inertialization** — carries the previous pose's position and velocity
 *    into the new state so transitions have no discontinuity.
 * 3. **Procedural secondary motion** — spring-driven cables, impact
 *    compression, velocity lean, head stabilisation. None of this is authored;
 *    it responds to what the character is actually doing.
 * 4. **Foot IK** — plants feet on the ground the character is really standing
 *    on, rather than where the clip happens to put them.
 *
 * Everything runs at *render* rate rather than simulation rate, so the
 * animation genuinely resolves 144 times a second on a 144 Hz display.
 */

import { Skeleton, Pose } from '../../anim/skeleton.ts';
import { Clip, blendPoses } from '../../anim/clip.ts';
import { Inertializer } from '../../anim/inertialize.ts';
import { solveTwoBone, createTwoBoneResult } from '../../anim/ik.ts';
import { spring, stepSpring, impulse, SPRING_PRESETS, type SpringState } from '../../core/math/spring.ts';
import { clamp, clamp01, damp, remapClamped, lerp } from '../../core/math/scalar.ts';
import { createOptimusSkeleton, resolveBoneIndices, type OptimusBoneIndices } from './rig.ts';
import { OPTIMUS_CLIPS } from './clips.ts';
import { OPTIMUS_DIMENSIONS as D } from '../../art/optimus.ts';

export const enum LocomotionState {
  Idle,
  Walk,
  Run,
  JumpRise,
  Fall,
  Land,
  Attack1,
  Attack2,
  Attack3,
}

/** What the animator needs to know about the character each frame. */
export interface AnimationInput {
  /** Horizontal speed in metres per second, always positive. */
  speed: number;
  /** Signed horizontal velocity. */
  velocityX: number;
  /** Signed vertical velocity; positive is downward. */
  velocityY: number;
  grounded: boolean;
  /** Index of the active combo step, or -1 when not attacking. */
  attackStep: number;
  /** Seconds since the current attack began. */
  attackTime: number;
  /** +1 faces right, -1 faces left. */
  facing: number;
  /** Ground surface angle in radians, for foot alignment. */
  groundAngle: number;
  /** World Y of the ground beneath the character. */
  groundY: number;
}

/** Blend thresholds, in metres per second. */
const WALK_SPEED = 1.9;
const RUN_SPEED = 6.2;

export class OptimusAnimator {
  readonly skeleton: Skeleton;
  readonly bones: OptimusBoneIndices;

  private readonly clips: Record<string, Clip>;
  private readonly inertializer: Inertializer;

  /** Scratch poses, reused every frame so the hot path never allocates. */
  private readonly basePose: Pose;
  private readonly blendPose: Pose;
  private readonly outputPose: Pose;

  private state: LocomotionState = LocomotionState.Idle;
  private stateTime = 0;
  /** Locomotion cycles share a phase so walk/run blends do not foot-skate. */
  private cyclePhase = 0;

  // --- Procedural motion state -------------------------------------------
  /** Vertical compression of the chassis on impact. */
  private readonly impactSpring: SpringState = spring(0);
  /** Forward lean driven by horizontal acceleration. */
  private readonly leanSpring: SpringState = spring(0);
  /** Trailing rotation of the two power cables. */
  private readonly cableSprings: SpringState[] = [spring(0), spring(0), spring(0), spring(0)];
  private previousVelocityX = 0;
  private previousGrounded = true;

  private readonly ikResult = createTwoBoneResult();

  /** Set when the character lands, so the game can spawn dust and shake. */
  landingImpact = 0;

  /** Seconds remaining on the additive flinch layer. */
  private hitReactRemaining = 0;

  /** Plays a flinch on top of the current pose. */
  triggerHitReact(): void {
    this.hitReactRemaining = OPTIMUS_CLIPS.HIT_REACT.duration;
  }

  constructor() {
    this.skeleton = createOptimusSkeleton();
    this.bones = resolveBoneIndices(this.skeleton);

    this.clips = {
      idle: new Clip(this.skeleton, OPTIMUS_CLIPS.IDLE),
      attack1: new Clip(this.skeleton, OPTIMUS_CLIPS.ATTACK_1),
      attack2: new Clip(this.skeleton, OPTIMUS_CLIPS.ATTACK_2),
      attack3: new Clip(this.skeleton, OPTIMUS_CLIPS.ATTACK_3),
      hitReact: new Clip(this.skeleton, OPTIMUS_CLIPS.HIT_REACT),
      walk: new Clip(this.skeleton, OPTIMUS_CLIPS.WALK),
      run: new Clip(this.skeleton, OPTIMUS_CLIPS.RUN),
      jumpRise: new Clip(this.skeleton, OPTIMUS_CLIPS.JUMP_RISE),
      fall: new Clip(this.skeleton, OPTIMUS_CLIPS.FALL),
      land: new Clip(this.skeleton, OPTIMUS_CLIPS.LAND),
    };

    const boneCount = this.skeleton.boneCount;
    this.basePose = new Pose(boneCount);
    this.blendPose = new Pose(boneCount);
    this.outputPose = new Pose(boneCount);
    this.inertializer = new Inertializer(boneCount);
  }

  /** Chooses the locomotion state from the character's actual motion. */
  private resolveState(input: AnimationInput): LocomotionState {
    // Attacks take priority over locomotion: the controller owns the combo
    // state machine, and the animator simply reflects it.
    if (input.attackStep >= 0) {
      return [LocomotionState.Attack1, LocomotionState.Attack2, LocomotionState.Attack3][
        Math.min(input.attackStep, 2)
      ]!;
    }
    if (!input.grounded) {
      // A small downward threshold rather than zero, so the animation does not
      // flicker between rise and fall at the apex.
      return input.velocityY < 0.6 ? LocomotionState.JumpRise : LocomotionState.Fall;
    }
    if (this.state === LocomotionState.Land && this.stateTime < this.clips.land!.duration) {
      return LocomotionState.Land;
    }
    if (input.speed < 0.35) return LocomotionState.Idle;
    return input.speed < WALK_SPEED * 1.6 ? LocomotionState.Walk : LocomotionState.Run;
  }

  /**
   * Advances the animation.
   *
   * @param dt Seconds since the last rendered frame, unscaled by hitstop —
   *   animation must keep resolving while the world is frozen, or an impact
   *   freeze looks like a crash.
   */
  update(input: AnimationInput, dt: number, worldX: number, worldY: number): void {
    this.landingImpact = 0;

    // --- Landing detection ------------------------------------------------
    if (input.grounded && !this.previousGrounded) {
      const impactVelocity = Math.max(0, this.previousVelocityY);
      // Below a threshold, stepping off a kerb should not trigger a full
      // landing animation.
      if (impactVelocity > 2.2) {
        this.landingImpact = clamp01(impactVelocity / 18);
        // Kick the spring rather than setting a position: the spring resolves
        // the compress-and-recover itself, and the depth scales with the real
        // impact velocity for free.
        impulse(this.impactSpring, -clamp(impactVelocity * 0.011, 0, 0.14));
        this.setState(LocomotionState.Land, 0.06);
      }
    }
    this.previousGrounded = input.grounded;
    this.previousVelocityY = input.velocityY;

    // --- State selection --------------------------------------------------
    const desired = this.resolveState(input);
    if (desired !== this.state) {
      // Transition durations are tuned per pair: leaving the ground must be
      // near-instant to feel responsive, while settling into an idle can be
      // leisurely.
      const duration = this.transitionDuration(this.state, desired);
      this.setState(desired, duration);
    }
    this.stateTime += dt;

    // --- Cycle phase ------------------------------------------------------
    // Driving the phase from distance travelled rather than from time is what
    // stops the feet sliding when speed changes: one stride always covers the
    // same ground.
    if (input.grounded && input.speed > 0.2) {
      // Stride length is derived from the clips, not chosen by feel.
      //
      // With a 0.81 m leg, the walk's 24/18 degree thigh sweep moves the foot
      // 0.58 m per step and the run's 42/32 degree sweep moves it 0.97 m, so a
      // full two-step cycle covers 1.16 m and 1.94 m respectively. The previous
      // values of 1.35 and 2.90 advanced the cycle far too slowly, and the feet
      // slid backwards across a third of the distance travelled.
      const strideLength = lerp(
        1.16,
        1.94,
        clamp01(remapClamped(input.speed, WALK_SPEED, RUN_SPEED, 0, 1)),
      );
      this.cyclePhase += (input.speed * dt) / strideLength;
      this.cyclePhase %= 1;
    }

    // --- Base pose --------------------------------------------------------
    this.samplePose(this.basePose, input, dt);

    // --- Inertialized output ---------------------------------------------
    this.inertializer.apply(this.basePose, this.outputPose, dt);

    // --- Additive flinch --------------------------------------------------
    // Layered rather than a state, so being hit while running does not
    // interrupt the run — the body reacts and carries on.
    if (this.hitReactRemaining > 0) {
      const duration = OPTIMUS_CLIPS.HIT_REACT.duration;
      const elapsed = duration - this.hitReactRemaining;
      this.clips.hitReact!.sampleAdditive(this.outputPose, elapsed, 1);
      this.hitReactRemaining -= dt;
    }

    // --- Procedural layers ------------------------------------------------
    this.applyProcedural(input, dt);

    // --- Resolve to world space -------------------------------------------
    this.skeleton.computeWorld(this.outputPose, worldX, worldY, input.facing);

    // Foot IK runs after the world transform, because it needs to know where
    // the feet actually ended up before it can correct them.
    if (input.grounded) {
      this.applyFootIK(input, worldX, worldY);
    }
  }

  private previousVelocityY = 0;

  private transitionDuration(from: LocomotionState, to: LocomotionState): number {
    // Leaving the ground: snappy, so the jump feels immediate.
    // Attacks must start instantly; anything slower is felt as input lag.
    if (
      to === LocomotionState.Attack1 ||
      to === LocomotionState.Attack2 ||
      to === LocomotionState.Attack3
    ) {
      return 0.04;
    }
    if (to === LocomotionState.JumpRise) return 0.055;
    if (to === LocomotionState.Land) return 0.06;
    // Walk and run share a structure, so they can cross quickly.
    if (
      (from === LocomotionState.Walk && to === LocomotionState.Run) ||
      (from === LocomotionState.Run && to === LocomotionState.Walk)
    ) {
      return 0.14;
    }
    if (to === LocomotionState.Idle) return 0.22;
    return 0.16;
  }

  private setState(state: LocomotionState, blendDuration: number): void {
    // The inertializer needs the *new* clip's pose at the transition instant to
    // measure the offset it must carry, so sample before switching state.
    const previousState = this.state;
    this.state = state;
    const previousTime = this.stateTime;
    this.stateTime = 0;

    this.samplePoseForState(this.blendPose, state, 0);
    this.inertializer.transition(this.blendPose, blendDuration);

    void previousState;
    void previousTime;
  }

  private samplePose(out: Pose, input: AnimationInput, dt: number): void {
    void dt;
    if (this.state === LocomotionState.Walk || this.state === LocomotionState.Run) {
      // Blendspace: walk against run, driven by speed. Both clips are sampled
      // at the same normalised phase so their contacts align and the blend
      // does not produce a limp.
      const t = clamp01(remapClamped(input.speed, WALK_SPEED, RUN_SPEED, 0, 1));
      this.lastBlendT = t;
      this.lastSpeed = input.speed;
      const walk = this.clips.walk!;
      const run = this.clips.run!;

      out.copyFrom(this.skeleton.restPose);
      walk.sample(out, this.cyclePhase * walk.duration, this.skeleton.restPose);

      this.blendPose.copyFrom(this.skeleton.restPose);
      run.sample(this.blendPose, this.cyclePhase * run.duration, this.skeleton.restPose);

      blendPoses(out, out, this.blendPose, t);
      return;
    }

    if (
      this.state === LocomotionState.Attack1 ||
      this.state === LocomotionState.Attack2 ||
      this.state === LocomotionState.Attack3
    ) {
      // Driven by the controller's timer, not a second clock here, so the
      // hitbox window and the pose can never drift apart.
      this.samplePoseForState(out, this.state, input.attackTime);
      return;
    }

    this.samplePoseForState(out, this.state, this.stateTime);
  }

  private samplePoseForState(out: Pose, state: LocomotionState, time: number): void {
    out.copyFrom(this.skeleton.restPose);

    switch (state) {
      case LocomotionState.Idle:
        this.clips.idle!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Walk:
        this.clips.walk!.sample(out, this.cyclePhase * this.clips.walk!.duration, this.skeleton.restPose);
        break;
      case LocomotionState.Run:
        this.clips.run!.sample(out, this.cyclePhase * this.clips.run!.duration, this.skeleton.restPose);
        break;
      case LocomotionState.JumpRise:
        this.clips.jumpRise!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Fall:
        this.clips.fall!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Land:
        this.clips.land!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Attack1:
        this.clips.attack1!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Attack2:
        this.clips.attack2!.sample(out, time, this.skeleton.restPose);
        break;
      case LocomotionState.Attack3:
        this.clips.attack3!.sample(out, time, this.skeleton.restPose);
        break;
      default: {
        const never: never = state;
        throw new Error(`Unhandled locomotion state: ${never}`);
      }
    }
  }

  /**
   * Secondary motion.
   *
   * None of this is authored. It is the character's body responding to forces,
   * which is what separates a rig that plays animations from one that feels
   * like a machine with mass.
   */
  private applyProcedural(input: AnimationInput, dt: number): void {
    const bones = this.bones;
    const pose = this.outputPose;

    // --- Impact compression ------------------------------------------------
    stepSpring(this.impactSpring, 0, SPRING_PRESETS.impact, dt);
    pose.y[bones.hips] = pose.y[bones.hips]! - this.impactSpring.value;
    // The knees absorb some of the compression, so the body folds rather than
    // simply sinking.
    const knee = this.impactSpring.value * 62;
    pose.rotation[bones.shinNear] = pose.rotation[bones.shinNear]! - knee * 0.017;
    pose.rotation[bones.shinFar] = pose.rotation[bones.shinFar]! - knee * 0.017;

    // --- Velocity lean -----------------------------------------------------
    // Acceleration, not velocity: leaning into a change of speed is what reads
    // as effort. Leaning purely by speed would make constant-velocity motion
    // look permanently off-balance.
    const acceleration = (input.velocityX - this.previousVelocityX) / Math.max(dt, 1e-5);
    this.previousVelocityX = input.velocityX;
    const targetLean = clamp(acceleration * 0.0022 * input.facing, -0.13, 0.13);
    stepSpring(this.leanSpring, targetLean, { frequency: 2.4, damping: 0.85 }, dt);

    pose.rotation[bones.abdomen] = pose.rotation[bones.abdomen]! - this.leanSpring.value * 0.55;
    pose.rotation[bones.chest] = pose.rotation[bones.chest]! - this.leanSpring.value * 0.75;
    // The head counter-rotates so the optic strip stays level and readable.
    pose.rotation[bones.head] = pose.rotation[bones.head]! + this.leanSpring.value * 0.9;

    // --- Cable sway --------------------------------------------------------
    // The cables trail the character's motion, lagging behind acceleration and
    // swinging on their own frequency.
    const sway = clamp(-input.velocityX * input.facing * 0.055, -0.5, 0.5);
    const bounce = clamp(input.velocityY * 0.03, -0.4, 0.4);

    const cableTargets = [sway * 0.9 + bounce, sway * 0.6, sway * 1.1 + bounce * 0.8, sway * 0.75];
    const cableBones = [
      bones.cableUpperA,
      bones.cableLowerA,
      bones.cableUpperB,
      bones.cableLowerB,
    ];
    for (let i = 0; i < 4; i++) {
      const preset = i % 2 === 0 ? SPRING_PRESETS.cable : SPRING_PRESETS.antenna;
      stepSpring(this.cableSprings[i]!, cableTargets[i]!, preset, dt);
      pose.rotation[cableBones[i]!] = pose.rotation[cableBones[i]!]! + this.cableSprings[i]!.value;
    }

    // --- Airborne pose shaping ---------------------------------------------
    if (!input.grounded) {
      // A continuous parameter on top of the discrete rise/fall clips, so the
      // arc between them reads as one motion rather than two states.
      // A continuous parameter layered on top of the discrete rise/fall clips.
      //
      // Without enough of it the character snaps into the rise pose at takeoff
      // and holds it, which reads as a single static frame rather than an arc.
      // Driving the whole body from vertical velocity means every point of the
      // jump is a different pose.
      const verticalBlend = clamp(input.velocityY / 11, -1, 1);
      pose.rotation[bones.chest] = pose.rotation[bones.chest]! + verticalBlend * 0.16;
      pose.rotation[bones.abdomen] = pose.rotation[bones.abdomen]! + verticalBlend * 0.10;
      pose.rotation[bones.head] = pose.rotation[bones.head]! - verticalBlend * 0.12;
      // Legs tuck on the way up and reach on the way down.
      pose.rotation[bones.thighNear] = pose.rotation[bones.thighNear]! - verticalBlend * 0.34;
      pose.rotation[bones.shinNear] = pose.rotation[bones.shinNear]! - verticalBlend * 0.30;
      pose.rotation[bones.thighFar] = pose.rotation[bones.thighFar]! + verticalBlend * 0.22;
      pose.rotation[bones.shinFar] = pose.rotation[bones.shinFar]! - verticalBlend * 0.18;
      // Arms counterbalance.
      pose.rotation[bones.upperArmNear] = pose.rotation[bones.upperArmNear]! + verticalBlend * 0.26;
      pose.rotation[bones.upperArmFar] = pose.rotation[bones.upperArmFar]! + verticalBlend * 0.20;
    }
  }

  /**
   * Plants the feet on the actual ground.
   *
   * Runs on the world pose, so it corrects wherever the clip left the foot.
   * Only applied when the foot is near the ground: a foot mid-swing must follow
   * the animation, not be dragged down to the floor.
   */
  private applyFootIK(input: AnimationInput, worldX: number, worldY: number): void {
    void worldX;
    const world = this.skeleton.world;
    const bones = this.bones;

    const legs: [number, number, number][] = [
      [bones.thighNear, bones.shinNear, bones.footNear],
      [bones.thighFar, bones.shinFar, bones.footFar],
    ];

    this.lastIkAppliedNear = 0;
    this.lastIkAppliedFar = 0;
    for (let legIndex = 0; legIndex < legs.length; legIndex++) {
      const [thigh, shin, foot] = legs[legIndex]!;
      const hipX = world.worldX[thigh]!;
      const hipY = world.worldY[thigh]!;
      const footX = world.worldX[foot]!;
      const footY = world.worldY[foot]!;

      const targetY = worldY - D.footHeight * 0.5;

      // Only correct a foot that is at or below the ground plane; a lifted foot
      // is mid-stride and must be left alone.
      const penetration = footY - targetY;
      if (penetration <= 0.005) continue;
      if (legIndex === 0) this.lastIkAppliedNear = penetration;
      else this.lastIkAppliedFar = penetration;

      // Blend the correction in, so a foot arriving at the ground is eased into
      // place rather than snapped.
      const weight = clamp01(penetration / 0.09);
      const correctedY = lerp(footY, targetY, weight);

      solveTwoBone(
        hipX,
        hipY,
        footX,
        correctedY,
        D.thighLength,
        D.shinLength,
        // The knee bends backward, which for a character facing right means a
        // negative bend direction.
        input.facing > 0,
        this.ikResult,
      );

      world.worldRotation[thigh] = this.ikResult.upperRotation;
      world.worldRotation[shin] = this.ikResult.lowerRotation;

      // Rebuild the chain below the corrected joints.
      const thighLength = D.thighLength;
      world.worldX[shin] = hipX + Math.cos(this.ikResult.upperRotation) * thighLength;
      world.worldY[shin] = hipY + Math.sin(this.ikResult.upperRotation) * thighLength;
      world.worldX[foot] = world.worldX[shin]! + Math.cos(this.ikResult.lowerRotation) * D.shinLength;
      world.worldY[foot] = world.worldY[shin]! + Math.sin(this.ikResult.lowerRotation) * D.shinLength;

      // Align the foot to the surface it is standing on.
      world.worldRotation[foot] = damp(
        world.worldRotation[foot]!,
        input.groundAngle,
        0.05,
        1 / 60,
      );
    }
  }

  reset(): void {
    this.inertializer.reset();
    this.state = LocomotionState.Idle;
    this.stateTime = 0;
    this.cyclePhase = 0;
    this.impactSpring.value = 0;
    this.impactSpring.velocity = 0;
    this.leanSpring.value = 0;
    this.leanSpring.velocity = 0;
    for (const cable of this.cableSprings) {
      cable.value = 0;
      cable.velocity = 0;
    }
  }

  get currentState(): LocomotionState {
    return this.state;
  }

  /** Diagnostic snapshot of the values that determine the current pose. */
  debugSnapshot(): Record<string, number> {
    return {
      state: this.state,
      stateTime: this.stateTime,
      cyclePhase: this.cyclePhase,
      lastSpeed: this.lastSpeed,
      blendT: this.lastBlendT,
      ikAppliedNear: this.lastIkAppliedNear,
      ikAppliedFar: this.lastIkAppliedFar,
      impact: this.impactSpring.value,
    };
  }

  private lastSpeed = 0;
  private lastBlendT = 0;
  private lastIkAppliedNear = 0;
  private lastIkAppliedFar = 0;
}
