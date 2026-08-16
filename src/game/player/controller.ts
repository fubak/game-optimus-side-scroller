/**
 * The player controller.
 *
 * ## Feel
 *
 * Everything here exists to make the character feel responsive despite being
 * heavy. The techniques are standard platformer practice, and each is included
 * because its absence is *felt* even by players who cannot name it:
 *
 * - **Coyote time** — jump still works for a moment after walking off an edge.
 *   Without it, players who pressed jump "at the edge" are told they missed,
 *   and the game feels like it is not listening.
 * - **Jump buffering** — a jump pressed just before landing fires on contact.
 * - **Variable jump height** — releasing early cuts the rise.
 * - **Apex hang** — gravity is reduced near the top of the arc, which both
 *   gives the player time to aim and reads as low Martian gravity.
 * - **Corner correction** — a jump that clips a ledge by a few centimetres is
 *   nudged around it rather than stopped dead.
 * - **Separate acceleration curves** for ground, air, and turning, because a
 *   single acceleration value cannot feel right in all three cases.
 *
 * All tuning constants live in {@link MOVEMENT} so they can be adjusted in one
 * place, and all of them are in metres and seconds.
 */

import { type AABB, aabb } from '../../core/math/aabb.ts';
import { moveToward, sign } from '../../core/math/scalar.ts';
import { PhysicsWorld, createMoveResult, type MoveResult } from '../physics.ts';
import { Input, Action } from '../../core/input.ts';
import { GRAVITY, SCALE } from '../../core/config.ts';

export const MOVEMENT = {
  /** Top ground speed when walking. */
  walkSpeed: 4.2,
  /** Top ground speed when running. */
  runSpeed: 8.4,

  /** Ground acceleration toward the target speed. */
  groundAcceleration: 42,
  /** Ground deceleration when there is no input. */
  groundFriction: 58,
  /**
   * Extra acceleration applied when reversing direction. Turning at the same
   * rate as accelerating from rest makes the character feel like it is on ice.
   */
  turnAcceleration: 96,

  airAcceleration: 26,
  airFriction: 8,
  /** Cap on air control, as a fraction of run speed. */
  airControl: 0.92,

  /** Initial upward velocity on jump. */
  jumpVelocity: 12.4,
  /** Multiplier applied to upward velocity when jump is released early. */
  jumpCutMultiplier: 0.42,
  /** Gravity multiplier while rising with jump held. */
  jumpRiseGravity: 0.86,
  /** Gravity multiplier while falling. */
  fallGravity: 1.16,
  /**
   * Gravity multiplier near the apex. The long hang is the single strongest
   * cue for low gravity, and it is where the player does their aiming.
   */
  apexGravity: 0.52,
  /** Vertical speed below which the apex modifier applies. */
  apexThreshold: 2.6,
  /** Terminal velocity. */
  maxFallSpeed: 26,
  /** Terminal velocity while fast-falling. */
  maxFastFallSpeed: 38,
  /** Downward acceleration added when holding down in the air. */
  fastFallAcceleration: 34,

  /** Grace period after leaving the ground during which jump still works. */
  coyoteTime: 0.09,
  /** How long a jump press is remembered. */
  jumpBuffer: 0.12,

  /** Horizontal distance a jump may be nudged to clear a ledge corner. */
  cornerCorrection: 0.14,

  /** Dash speed. */
  dashSpeed: 21,
  dashDuration: 0.155,
  dashCooldown: 0.34,
  /** Invulnerability window during a dash. */
  dashInvulnerable: 0.13,
  /** Velocity retained when a dash ends. */
  dashExitSpeed: 0.55,

  /** Downward speed while sliding down a wall. */
  wallSlideSpeed: 3.4,
  wallJumpVelocityX: 8.2,
  wallJumpVelocityY: 11.6,
  /** How long horizontal control is suppressed after a wall jump. */
  wallJumpLockout: 0.16,
} as const;

export const enum PlayerState {
  Grounded,
  Airborne,
  Dashing,
  WallSliding,
}

export class PlayerController {
  /** Collision box. Its centre is the character's body centre, not its feet. */
  readonly box: AABB;

  velocityX = 0;
  velocityY = 0;
  facing = 1;
  state: PlayerState = PlayerState.Airborne;

  grounded = false;
  groundAngle = 0;
  groundY = 0;
  wallSide = 0;

  /** True while dash invulnerability is active. */
  invulnerable = false;

  private coyoteRemaining = 0;
  private dashRemaining = 0;
  private dashCooldownRemaining = 0;
  private dashDirectionX = 0;
  private dashDirectionY = 0;
  private wallJumpLockRemaining = 0;
  private jumpHeld = false;
  private airJumpsRemaining = 0;

  private readonly moveResult: MoveResult = createMoveResult();

  /** Set for one step when a jump is initiated, for VFX and audio. */
  jumpedThisStep = false;
  /** Set for one step when a dash starts. */
  dashedThisStep = false;
  /** Impact speed on the step the character landed, or zero. */
  landedThisStep = 0;

  constructor(
    private readonly world: PhysicsWorld,
    x: number,
    y: number,
  ) {
    this.box = aabb(x, y - SCALE.optimusBodyHeight / 2, SCALE.optimusBodyWidth / 2, SCALE.optimusBodyHeight / 2);
  }

  /** World position of the character's feet, which is what the rig is anchored to. */
  get feetX(): number {
    return this.box.x;
  }

  get feetY(): number {
    return this.box.y + this.box.hh;
  }

  teleport(x: number, y: number): void {
    this.box.x = x;
    this.box.y = y - this.box.hh;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  /**
   * Advances one fixed simulation step.
   *
   * Runs at exactly 120 Hz, so every constant above is frame-rate independent
   * by construction rather than by tuning.
   */
  update(input: Input, dt: number): void {
    this.jumpedThisStep = false;
    this.dashedThisStep = false;
    this.landedThisStep = 0;

    const wasGrounded = this.grounded;
    const previousVelocityY = this.velocityY;

    this.tickTimers(dt);

    if (this.state === PlayerState.Dashing) {
      this.updateDash(dt);
    } else {
      this.updateHorizontal(input, dt);
      this.updateVertical(input, dt);
      this.tryDash(input);
    }

    this.applyMovement(dt);

    // Landing is detected after resolution, so the impact speed is the real
    // one rather than the value it would have had without a collision.
    if (this.grounded && !wasGrounded) {
      this.landedThisStep = Math.max(0, previousVelocityY);
      this.airJumpsRemaining = 0;
    }

    this.updateState();
  }

  private tickTimers(dt: number): void {
    if (this.grounded) {
      this.coyoteRemaining = MOVEMENT.coyoteTime;
    } else {
      this.coyoteRemaining = Math.max(0, this.coyoteRemaining - dt);
    }
    this.dashCooldownRemaining = Math.max(0, this.dashCooldownRemaining - dt);
    this.wallJumpLockRemaining = Math.max(0, this.wallJumpLockRemaining - dt);
    if (this.dashRemaining > 0) {
      this.dashRemaining -= dt;
      this.invulnerable = this.dashRemaining > MOVEMENT.dashDuration - MOVEMENT.dashInvulnerable;
    } else {
      this.invulnerable = false;
    }
  }

  private updateHorizontal(input: Input, dt: number): void {
    // A wall jump briefly overrides input, or holding toward the wall would
    // immediately cancel the push-off and the jump would go nowhere.
    const moveX = this.wallJumpLockRemaining > 0 ? 0 : input.moveX;

    const running = input.isHeld(Action.Dash) || Math.abs(moveX) > 0.85;
    const targetSpeed = moveX * (running ? MOVEMENT.runSpeed : MOVEMENT.walkSpeed);

    if (Math.abs(moveX) > 0.05) {
      // Reversing gets its own, much higher acceleration.
      const reversing = sign(moveX) !== 0 && sign(this.velocityX) !== 0 && sign(moveX) !== sign(this.velocityX);
      const acceleration = this.grounded
        ? reversing
          ? MOVEMENT.turnAcceleration
          : MOVEMENT.groundAcceleration
        : MOVEMENT.airAcceleration;

      this.velocityX = moveToward(this.velocityX, targetSpeed, acceleration * dt);
      this.facing = sign(moveX);
    } else {
      const friction = this.grounded ? MOVEMENT.groundFriction : MOVEMENT.airFriction;
      this.velocityX = moveToward(this.velocityX, 0, friction * dt);
    }

    if (!this.grounded) {
      const cap = MOVEMENT.runSpeed * MOVEMENT.airControl;
      // Only clamp speeds gained from air control; momentum from a dash or a
      // wall jump is allowed to exceed the cap and decay naturally.
      if (Math.abs(this.velocityX) > cap && Math.abs(moveX) > 0.05) {
        this.velocityX = moveToward(this.velocityX, sign(this.velocityX) * cap, MOVEMENT.airFriction * dt);
      }
    }
  }

  private updateVertical(input: Input, dt: number): void {
    const jumpHeldNow = input.isHeld(Action.Jump);

    // --- Jump initiation ---------------------------------------------------
    const canGroundJump = this.grounded || this.coyoteRemaining > 0;
    const canWallJump = this.state === PlayerState.WallSliding && this.wallSide !== 0;

    if (input.wasPressedBuffered(Action.Jump, MOVEMENT.jumpBuffer)) {
      if (canWallJump) {
        input.consumePress(Action.Jump);
        this.velocityY = -MOVEMENT.wallJumpVelocityY;
        this.velocityX = -this.wallSide * MOVEMENT.wallJumpVelocityX;
        this.facing = -this.wallSide;
        this.wallJumpLockRemaining = MOVEMENT.wallJumpLockout;
        this.coyoteRemaining = 0;
        this.jumpedThisStep = true;
      } else if (canGroundJump) {
        input.consumePress(Action.Jump);
        this.velocityY = -MOVEMENT.jumpVelocity;
        this.coyoteRemaining = 0;
        this.grounded = false;
        this.jumpedThisStep = true;
      }
    }

    // --- Variable jump height ---------------------------------------------
    // Releasing jump while still rising cuts the remaining upward velocity, so
    // the player has continuous control over height rather than two fixed
    // options.
    if (this.jumpHeld && !jumpHeldNow && this.velocityY < 0) {
      this.velocityY *= MOVEMENT.jumpCutMultiplier;
    }
    this.jumpHeld = jumpHeldNow;

    // --- Gravity ----------------------------------------------------------
    if (this.state === PlayerState.WallSliding) {
      this.velocityY = Math.min(this.velocityY + GRAVITY * 0.35 * dt, MOVEMENT.wallSlideSpeed);
      return;
    }

    let gravityScale: number;
    if (Math.abs(this.velocityY) < MOVEMENT.apexThreshold) {
      gravityScale = MOVEMENT.apexGravity;
    } else if (this.velocityY < 0) {
      gravityScale = jumpHeldNow ? MOVEMENT.jumpRiseGravity : MOVEMENT.fallGravity;
    } else {
      gravityScale = MOVEMENT.fallGravity;
    }

    this.velocityY += GRAVITY * gravityScale * dt;

    // --- Fast fall ---------------------------------------------------------
    const fastFalling = input.isHeld(Action.Down) && !this.grounded;
    if (fastFalling && this.velocityY > 0) {
      this.velocityY += MOVEMENT.fastFallAcceleration * dt;
    }

    const maxFall = fastFalling ? MOVEMENT.maxFastFallSpeed : MOVEMENT.maxFallSpeed;
    if (this.velocityY > maxFall) this.velocityY = maxFall;
  }

  private tryDash(input: Input): void {
    if (this.dashCooldownRemaining > 0) return;
    if (!input.wasPressedBuffered(Action.Dash, 0.1)) return;
    // Dash is bound alongside sprint; only a fresh press should dash.
    if (!input.wasPressed(Action.Dash)) return;

    input.consumePress(Action.Dash);

    // Eight-way, falling back to the facing direction when there is no input.
    let dirX = Math.abs(input.moveX) > 0.3 ? sign(input.moveX) : 0;
    let dirY = Math.abs(input.moveY) > 0.3 ? sign(input.moveY) : 0;
    if (dirX === 0 && dirY === 0) dirX = this.facing;

    const length = Math.hypot(dirX, dirY);
    this.dashDirectionX = dirX / length;
    this.dashDirectionY = dirY / length;

    this.dashRemaining = MOVEMENT.dashDuration;
    this.dashCooldownRemaining = MOVEMENT.dashDuration + MOVEMENT.dashCooldown;
    this.state = PlayerState.Dashing;
    this.dashedThisStep = true;
    if (dirX !== 0) this.facing = sign(dirX);
  }

  private updateDash(dt: number): void {
    void dt;
    this.velocityX = this.dashDirectionX * MOVEMENT.dashSpeed;
    this.velocityY = this.dashDirectionY * MOVEMENT.dashSpeed;

    if (this.dashRemaining <= 0) {
      // Bleed off into normal movement rather than stopping dead, so a dash
      // can be chained into a jump without losing all its momentum.
      this.velocityX *= MOVEMENT.dashExitSpeed;
      this.velocityY *= MOVEMENT.dashExitSpeed * 0.5;
      this.state = this.grounded ? PlayerState.Grounded : PlayerState.Airborne;
    }
  }

  private applyMovement(dt: number): void {
    const result = this.world.move(this.box, this.velocityX, this.velocityY, dt, this.moveResult);

    // --- Corner correction -------------------------------------------------
    // A rising jump that clips a ledge by a few centimetres is nudged sideways
    // around it. Without this, near-misses stop the player dead against a
    // corner and feel like the game is being unfair.
    if (result.ceiling && this.velocityY < 0) {
      for (const offset of [MOVEMENT.cornerCorrection, -MOVEMENT.cornerCorrection]) {
        const testX = this.box.x + offset;
        const probe = aabb(testX, this.box.y - 0.02, this.box.hw, this.box.hh);
        if (!this.world.isOverlapping(probe)) {
          this.box.x = testX;
          // Keep the upward velocity: the jump continues past the corner.
          this.velocityY = Math.min(this.velocityY, -0.5);
          break;
        }
      }
    }

    this.velocityX = result.velocityX;
    this.velocityY = result.velocityY;
    this.grounded = result.grounded;
    this.groundAngle = result.groundAngle;
    this.wallSide = result.wall;

    if (result.grounded) {
      this.groundY = result.groundY;
    } else {
      // Probe below so foot IK and coyote logic know about nearby ground.
      const probe = this.world.probeGround(this.box, 0.25);
      if (probe.hit) {
        this.groundY = probe.y;
        this.groundAngle = probe.angle;

        // --- Ground snapping ---------------------------------------------
        // Collision resolution leaves a small skin gap, so a body at rest
        // separates from the floor, falls back onto it, and separates again.
        // That made `grounded` flicker every other step, which in turn
        // flickered the animation state and repeatedly reset the coyote timer.
        //
        // Snapping to a surface that is within a couple of millimetres, while
        // moving downward, makes standing still genuinely stable. The downward
        // check is what stops it from cancelling a jump the instant it starts.
        const feetGap = probe.y - (this.box.y + this.box.hh);
        if (this.velocityY >= 0 && feetGap >= -0.004 && feetGap < 0.06) {
          this.box.y = probe.y - this.box.hh;
          this.velocityY = 0;
          this.grounded = true;
          this.groundY = probe.y;
        }
      }
    }
  }

  private updateState(): void {
    if (this.state === PlayerState.Dashing && this.dashRemaining > 0) return;

    if (this.grounded) {
      this.state = PlayerState.Grounded;
      return;
    }

    // Wall slide requires pressing into the wall while falling, so brushing a
    // wall mid-jump does not stick the character to it.
    if (this.wallSide !== 0 && this.velocityY > 0 && sign(this.velocityX) === this.wallSide) {
      this.state = PlayerState.WallSliding;
      this.facing = -this.wallSide;
      return;
    }

    this.state = PlayerState.Airborne;
  }

  get speed(): number {
    return Math.abs(this.velocityX);
  }

  get airJumps(): number {
    return this.airJumpsRemaining;
  }
}
