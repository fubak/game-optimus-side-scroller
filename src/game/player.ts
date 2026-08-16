import { approach, clamp, sign } from '../core/math';
import type { Input } from '../core/input';
import {
  AIR_ACCEL,
  AIR_DRAG,
  APEX_GRAVITY_MULTIPLIER,
  APEX_SPEED_WINDOW,
  COYOTE_TIME,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_ENERGY_COST,
  DASH_EXIT_SPEED_FACTOR,
  DASH_SPEED,
  DEATH_POP_SPEED,
  DEATH_TIME,
  ENERGY_MAX,
  ENERGY_REGEN_DELAY,
  ENERGY_REGEN_PER_SEC,
  FOOTSTEP_INTERVAL,
  GRAVITY_FALLING,
  GRAVITY_RISING,
  GROUND_CLEARANCE_PROBE,
  GROUND_FRICTION,
  HEALTH_MAX,
  HURT_CONTROL_LOCK,
  HURT_KNOCKBACK_X,
  HURT_KNOCKBACK_Y,
  IDLE_SPEED_THRESHOLD,
  INVULNERABLE_TIME,
  JUMP_BUFFER_TIME,
  JUMP_CUT_MULTIPLIER,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MIN_JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  RUN_ACCEL,
  RUN_MAX_SPEED,
  THRUST_ACCEL,
  THRUST_ENERGY_DRAIN,
  THRUST_INITIAL_BOOST,
  THRUST_MAX_RISE_SPEED,
  THRUST_MIN_CLEARANCE,
} from './constants';
import { createBody, createCollisionResult, distanceToGround, isGrounded, moveAndCollide } from './physics';
import type { Body, CollisionResult } from './physics';
import type { TileMap } from './tilemap';
import { conveyorSpeed } from './tiles';

/**
 * Optimus — the player character.
 *
 * The movement model is a small explicit state machine plus the platformer "feel" tricks that make
 * a 2D character feel fair: coyote time, jump buffering, variable jump height, apex hang, a
 * cooldown dash and a jetpack thrust that spends energy. All of it is driven by the fixed timestep
 * and an {@link Input}, so a tape of button presses reproduces a run exactly.
 */

export type PlayerState = 'idle' | 'run' | 'jump' | 'fall' | 'thrust' | 'dash' | 'hurt' | 'dead' | 'victory';

export type PlayerEvent =
  | { readonly type: 'jump' }
  | { readonly type: 'land'; readonly impactSpeed: number }
  | { readonly type: 'dash' }
  | { readonly type: 'thrustStart' }
  | { readonly type: 'thrustStop' }
  | { readonly type: 'footstep' }
  | { readonly type: 'hurt'; readonly healthLeft: number }
  | { readonly type: 'die' }
  | { readonly type: 'energyEmpty' }
  | { readonly type: 'ceilingBonk' };

export class Player {
  readonly body: Body;
  private currentState: PlayerState = 'idle';
  private facingDirection: 1 | -1 = 1;
  private animationTime = 0;
  private currentHealth = HEALTH_MAX;
  private currentEnergy = ENERGY_MAX;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private dashTimer = 0;
  private dashCooldownTimer = 0;
  private invulnerableTimer = 0;
  private hurtTimer = 0;
  private deathTimer = 0;
  private energyRegenDelayTimer = 0;
  private footstepTimer = 0;
  /** Set when jump is pressed in mid-air; while it is held, thrust engages. */
  private thrustArmed = false;
  /**
   * A mid-air press close to the ground is held here until the jump-buffer window lapses: if the
   * player lands in time it becomes a buffered jump, otherwise it arms the jetpack.
   */
  private thrustArmPending = false;
  /** Gap below the feet, refreshed each frame (see {@link THRUST_MIN_CLEARANCE}). */
  private groundClearance = Number.POSITIVE_INFINITY;
  private wasThrusting = false;
  private grounded = false;
  /**
   * Set on spawn: the very first update probes the map to learn whether the feet are on solid
   * ground. Without it the player would spend frame 0 believing it was airborne, which would arm
   * the jetpack and fire a phantom landing event the instant the level starts.
   */
  private needsGroundProbe = true;
  private beltSpeed = 0;
  /** Vertical speed before the last move, so landings can report a real impact speed. */
  private preMoveVy = 0;
  private readonly collision: CollisionResult = createCollisionResult();

  constructor(x = 0, y = 0) {
    this.body = createBody(x, y, PLAYER_WIDTH, PLAYER_HEIGHT);
  }

  get state(): PlayerState {
    return this.currentState;
  }

  get facing(): 1 | -1 {
    return this.facingDirection;
  }

  get animTime(): number {
    return this.animationTime;
  }

  get health(): number {
    return this.currentHealth;
  }

  get energy(): number {
    return this.currentEnergy;
  }

  get energyRatio(): number {
    return this.currentEnergy / ENERGY_MAX;
  }

  get isOnGround(): boolean {
    return this.grounded;
  }

  get isAlive(): boolean {
    return this.currentState !== 'dead';
  }

  get isInvulnerable(): boolean {
    return this.invulnerableTimer > 0;
  }

  /** True on alternate blink windows while invulnerable — the renderer hides the sprite then. */
  get isBlinking(): boolean {
    return this.invulnerableTimer > 0;
  }

  get invulnerableTime(): number {
    return this.invulnerableTimer;
  }

  get deathElapsed(): number {
    return this.deathTimer;
  }

  /** Dash readiness in 0..1 (1 = ready), for the HUD. */
  get dashCharge(): number {
    return 1 - clamp(this.dashCooldownTimer / DASH_COOLDOWN, 0, 1);
  }

  get lastCollision(): CollisionResult {
    return this.collision;
  }

  get centerX(): number {
    return this.body.x + this.body.width / 2;
  }

  get centerY(): number {
    return this.body.y + this.body.height / 2;
  }

  /** Place the player at a spawn/checkpoint and clear transient state (keeps score-side stats). */
  respawn(x: number, y: number, options: { readonly keepHealth?: boolean } = {}): void {
    this.body.x = x;
    this.body.y = y;
    this.body.vx = 0;
    this.body.vy = 0;
    this.currentState = 'idle';
    this.facingDirection = 1;
    this.animationTime = 0;
    if (options.keepHealth !== true) this.currentHealth = HEALTH_MAX;
    this.currentEnergy = ENERGY_MAX;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.invulnerableTimer = 0;
    this.hurtTimer = 0;
    this.deathTimer = 0;
    this.energyRegenDelayTimer = 0;
    this.footstepTimer = 0;
    this.thrustArmed = false;
    this.thrustArmPending = false;
    this.wasThrusting = false;
    this.grounded = false;
    this.needsGroundProbe = true;
    this.beltSpeed = 0;
  }

  update(dtSec: number, input: Input, map: TileMap, events: PlayerEvent[]): CollisionResult {
    this.animationTime += dtSec;
    if (this.needsGroundProbe) {
      this.grounded = isGrounded(this.body, map);
      this.needsGroundProbe = false;
    }
    this.tickTimers(dtSec);

    const wantsLeft = input.isDown('left');
    const wantsRight = input.isDown('right');
    const moveDirection = (wantsRight ? 1 : 0) - (wantsLeft ? 1 : 0);
    const jumpHeld = input.isDown('jump');
    const jumpPressed = input.justPressed('jump');
    const dropThrough = input.isDown('down');

    this.groundClearance = distanceToGround(this.body, map, GROUND_CLEARANCE_PROBE);

    if (jumpPressed) this.jumpBufferTimer = JUMP_BUFFER_TIME;
    if (!jumpHeld) {
      this.thrustArmed = false;
      this.thrustArmPending = false;
    }
    // A deferred mid-air press becomes jetpack arming once it can no longer be a buffered jump.
    if (this.thrustArmPending && this.jumpBufferTimer <= 0) {
      this.thrustArmPending = false;
      if (jumpHeld && !this.grounded) this.thrustArmed = true;
    }

    if (this.canAct()) {
      this.applyHorizontalControl(dtSec, moveDirection);
      this.tryJump(events, jumpPressed);
      this.applyJumpCut(jumpHeld);
      this.tryDash(dtSec, input, events);
      this.applyThrust(dtSec, jumpHeld, jumpPressed, events);
    } else {
      this.applyPassiveDrag(dtSec);
    }

    if (this.currentState !== 'dash') {
      this.applyGravity(dtSec);
    }

    this.moveWithConveyor(dtSec, map, dropThrough);
    this.resolvePostMoveState(events, moveDirection);
    this.updateFootsteps(dtSec, events);
    this.regenerateEnergy(dtSec);

    return this.collision;
  }

  /** Apply damage from a hazard/enemy. Returns true when the hit landed. */
  damage(amount: number, sourceX: number, events: PlayerEvent[]): boolean {
    if (this.invulnerableTimer > 0 || this.currentState === 'dead' || this.currentState === 'victory') {
      return false;
    }
    this.currentHealth = Math.max(0, this.currentHealth - amount);
    if (this.currentHealth === 0) {
      this.kill(events);
      return true;
    }
    this.setState('hurt');
    this.hurtTimer = HURT_CONTROL_LOCK;
    this.invulnerableTimer = INVULNERABLE_TIME;
    const away = sourceX <= this.centerX ? 1 : -1;
    this.body.vx = away * HURT_KNOCKBACK_X;
    this.body.vy = HURT_KNOCKBACK_Y;
    this.thrustArmed = false;
    events.push({ type: 'hurt', healthLeft: this.currentHealth });
    return true;
  }

  /** Instant death (pit, crusher, running out of health). */
  kill(events: PlayerEvent[]): void {
    if (this.currentState === 'dead') return;
    this.currentHealth = 0;
    this.setState('dead');
    this.deathTimer = 0;
    this.body.vx = 0;
    this.body.vy = -DEATH_POP_SPEED;
    this.invulnerableTimer = 0;
    this.thrustArmed = false;
    events.push({ type: 'die' });
  }

  /** True once the death animation has played long enough to respawn. */
  get deathAnimationFinished(): boolean {
    return this.currentState === 'dead' && this.deathTimer >= DEATH_TIME;
  }

  /** Bounce off a stomped enemy. */
  bounce(speed: number): void {
    this.body.vy = -speed;
    if (this.currentState !== 'dead' && this.currentState !== 'victory') {
      this.setState('jump');
      // A stomp re-arms thrust, so a held jump button keeps the chain going.
      this.thrustArmed = false;
    }
  }

  /** Freeze control for the level-complete celebration. */
  celebrate(): void {
    if (this.currentState === 'dead') return;
    this.setState('victory');
    this.body.vx = 0;
  }

  addEnergy(amount: number): void {
    this.currentEnergy = clamp(this.currentEnergy + amount, 0, ENERGY_MAX);
  }

  heal(amount: number): boolean {
    if (this.currentHealth >= HEALTH_MAX) return false;
    this.currentHealth = Math.min(HEALTH_MAX, this.currentHealth + amount);
    return true;
  }

  private canAct(): boolean {
    switch (this.currentState) {
      case 'idle':
      case 'run':
      case 'jump':
      case 'fall':
      case 'thrust':
      case 'dash':
        return true;
      case 'hurt':
      case 'dead':
      case 'victory':
        return false;
      default: {
        const exhaustive: never = this.currentState;
        throw new Error(`Unhandled player state: ${String(exhaustive)}`);
      }
    }
  }

  private setState(next: PlayerState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.animationTime = 0;
  }

  private tickTimers(dtSec: number): void {
    this.coyoteTimer = Math.max(0, this.coyoteTimer - dtSec);
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dtSec);
    this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dtSec);
    this.invulnerableTimer = Math.max(0, this.invulnerableTimer - dtSec);
    this.energyRegenDelayTimer = Math.max(0, this.energyRegenDelayTimer - dtSec);
    if (this.currentState === 'hurt') {
      this.hurtTimer = Math.max(0, this.hurtTimer - dtSec);
    }
    if (this.currentState === 'dead') {
      this.deathTimer += dtSec;
    }
  }

  private applyHorizontalControl(dtSec: number, moveDirection: number): void {
    if (this.currentState === 'dash') return;

    if (moveDirection !== 0) {
      this.facingDirection = moveDirection > 0 ? 1 : -1;
      const accel = this.grounded ? RUN_ACCEL : AIR_ACCEL;
      this.body.vx = approach(this.body.vx, moveDirection * RUN_MAX_SPEED, accel * dtSec);
    } else {
      const drag = this.grounded ? GROUND_FRICTION : AIR_DRAG;
      this.body.vx = approach(this.body.vx, 0, drag * dtSec);
    }
  }

  private applyPassiveDrag(dtSec: number): void {
    const drag = this.grounded ? GROUND_FRICTION * 0.6 : AIR_DRAG * 0.5;
    this.body.vx = approach(this.body.vx, 0, drag * dtSec);
  }

  private tryJump(events: PlayerEvent[], jumpPressed: boolean): void {
    if (this.currentState === 'dash') return;
    const canJump = this.grounded || this.coyoteTimer > 0;
    if (this.jumpBufferTimer <= 0 || !canJump) {
      // A press with no ground under it goes to the jetpack — immediately when there is room to
      // fly, or deferred while the press could still turn into a jump on touchdown.
      if (jumpPressed && !this.grounded && this.coyoteTimer <= 0) {
        if (this.isAboutToLand()) {
          this.thrustArmPending = true;
        } else {
          this.thrustArmed = true;
        }
      }
      return;
    }
    this.body.vy = -JUMP_SPEED;
    this.grounded = false;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.thrustArmed = false;
    this.thrustArmPending = false;
    this.setState('jump');
    events.push({ type: 'jump' });
  }

  /**
   * Will the feet reach the ground within the jump-buffer window?
   *
   * Uses time-to-touchdown rather than a fixed distance so it behaves the same whether the player
   * is drifting down gently or slamming in at terminal velocity.
   */
  private isAboutToLand(): boolean {
    if (!Number.isFinite(this.groundClearance)) return false;
    if (this.groundClearance <= THRUST_MIN_CLEARANCE) return true;
    if (this.body.vy <= 0) return false;
    // Solve clearance = v·t + ½·g·t² for t. A linear v-only estimate over-predicts the time and
    // would let a press one frame outside the window fire the jetpack instead of buffering.
    const speed = this.body.vy;
    const timeToGround =
      (Math.sqrt(speed * speed + 2 * GRAVITY_FALLING * this.groundClearance) - speed) / GRAVITY_FALLING;
    return timeToGround <= JUMP_BUFFER_TIME;
  }

  private applyJumpCut(jumpHeld: boolean): void {
    if (jumpHeld) return;
    if (this.currentState !== 'jump' && this.currentState !== 'thrust') return;
    // Cut the rise, but never below the minimum hop: a tap must still clear one tile. Rises that
    // are already slower than the minimum are left untouched (cutting them would be a no-op).
    if (this.body.vy < -MIN_JUMP_SPEED) {
      this.body.vy = Math.min(this.body.vy * JUMP_CUT_MULTIPLIER, -MIN_JUMP_SPEED);
    }
  }

  private tryDash(dtSec: number, input: Input, events: PlayerEvent[]): void {
    if (this.currentState === 'dash') {
      this.dashTimer -= dtSec;
      this.body.vy = 0;
      this.body.vx = this.facingDirection * DASH_SPEED;
      if (this.dashTimer <= 0) {
        this.body.vx = this.facingDirection * DASH_SPEED * DASH_EXIT_SPEED_FACTOR;
        this.setState(this.grounded ? 'idle' : 'fall');
      }
      return;
    }
    if (!input.justPressed('dash')) return;
    if (this.dashCooldownTimer > 0) return;
    if (this.currentEnergy < DASH_ENERGY_COST) {
      events.push({ type: 'energyEmpty' });
      return;
    }
    this.spendEnergy(DASH_ENERGY_COST);
    this.dashTimer = DASH_DURATION;
    this.dashCooldownTimer = DASH_COOLDOWN;
    this.body.vy = 0;
    this.body.vx = this.facingDirection * DASH_SPEED;
    this.setState('dash');
    events.push({ type: 'dash' });
  }

  private applyThrust(dtSec: number, jumpHeld: boolean, jumpPressed: boolean, events: PlayerEvent[]): void {
    if (this.currentState === 'dash') return;

    const wantsThrust = this.thrustArmed && jumpHeld && !this.grounded;
    if (wantsThrust && this.currentEnergy > 0) {
      if (!this.wasThrusting) {
        this.body.vy = Math.min(this.body.vy, -THRUST_INITIAL_BOOST);
        events.push({ type: 'thrustStart' });
      }
      this.body.vy = Math.max(this.body.vy - THRUST_ACCEL * dtSec, -THRUST_MAX_RISE_SPEED);
      this.spendEnergy(THRUST_ENERGY_DRAIN * dtSec);
      this.setState('thrust');
      this.wasThrusting = true;
      if (this.currentEnergy <= 0) {
        events.push({ type: 'energyEmpty' });
      }
      return;
    }

    if (this.wasThrusting) {
      events.push({ type: 'thrustStop' });
      this.wasThrusting = false;
      if (this.currentState === 'thrust') this.setState('fall');
    }
    if (jumpPressed && !this.grounded && this.currentEnergy <= 0) {
      events.push({ type: 'energyEmpty' });
    }
  }

  private applyGravity(dtSec: number): void {
    const rising = this.body.vy < 0;
    let gravity = rising ? GRAVITY_RISING : GRAVITY_FALLING;
    if (Math.abs(this.body.vy) < APEX_SPEED_WINDOW && this.currentState !== 'dead') {
      gravity *= APEX_GRAVITY_MULTIPLIER;
    }
    this.body.vy = Math.min(this.body.vy + gravity * dtSec, MAX_FALL_SPEED);
  }

  /**
   * Move through the world, folding in conveyor belt drift.
   *
   * The belt is added to the velocity only for the move itself and then removed again, so the
   * player's own run speed is unaffected by standing on a belt (and a wall still cancels both).
   */
  private moveWithConveyor(dtSec: number, map: TileMap, dropThrough: boolean): void {
    this.preMoveVy = this.body.vy;
    const belt = this.beltSpeed;
    this.body.vx += belt;
    moveAndCollide(this.body, dtSec, map, this.collision, {
      dropThroughOneWay: dropThrough && this.grounded,
    });
    if (this.collision.hitWallLeft || this.collision.hitWallRight) {
      this.body.vx = 0;
    } else {
      this.body.vx -= belt;
    }
    this.beltSpeed = this.collision.groundKind === null ? 0 : conveyorSpeed(this.collision.groundKind);
  }

  private resolvePostMoveState(events: PlayerEvent[], moveDirection: number): void {
    const wasGrounded = this.grounded;
    // Landing impact must be the speed *before* the collision zeroed it out.
    const impactSpeed = this.preMoveVy;
    this.grounded = this.collision.onGround;

    if (this.collision.onCeiling && this.currentState !== 'dead') {
      events.push({ type: 'ceilingBonk' });
    }

    if (this.grounded && !wasGrounded) {
      events.push({ type: 'land', impactSpeed });
      this.thrustArmed = false;
      this.thrustArmPending = false;
      this.wasThrusting = false;
    }
    if (!this.grounded && wasGrounded) {
      this.coyoteTimer = COYOTE_TIME;
    }

    switch (this.currentState) {
      case 'idle':
      case 'run':
        if (!this.grounded) {
          this.setState(this.body.vy < 0 ? 'jump' : 'fall');
        } else {
          const moving = Math.abs(this.body.vx) > IDLE_SPEED_THRESHOLD || moveDirection !== 0;
          this.setState(moving ? 'run' : 'idle');
        }
        break;
      case 'jump':
        if (this.grounded) this.setState(Math.abs(this.body.vx) > IDLE_SPEED_THRESHOLD ? 'run' : 'idle');
        else if (this.body.vy >= 0) this.setState('fall');
        break;
      case 'fall':
      case 'thrust':
        if (this.grounded) this.setState(Math.abs(this.body.vx) > IDLE_SPEED_THRESHOLD ? 'run' : 'idle');
        break;
      case 'dash':
        break;
      case 'hurt':
        if (this.hurtTimer <= 0) {
          this.setState(this.grounded ? 'idle' : 'fall');
        }
        break;
      case 'dead':
      case 'victory':
        break;
      default: {
        const exhaustive: never = this.currentState;
        throw new Error(`Unhandled player state: ${String(exhaustive)}`);
      }
    }
  }

  private updateFootsteps(dtSec: number, events: PlayerEvent[]): void {
    if (this.currentState !== 'run') {
      this.footstepTimer = 0;
      return;
    }
    this.footstepTimer += dtSec;
    if (this.footstepTimer >= FOOTSTEP_INTERVAL) {
      this.footstepTimer -= FOOTSTEP_INTERVAL;
      events.push({ type: 'footstep' });
    }
  }

  private spendEnergy(amount: number): void {
    this.currentEnergy = Math.max(0, this.currentEnergy - amount);
    this.energyRegenDelayTimer = ENERGY_REGEN_DELAY;
  }

  /**
   * Energy only refills with both feet on the floor.
   *
   * Recharging mid-air would let a held jump button stutter the jetpack on and off forever, and it
   * would remove the reason to ever land. Touching down is the recharge.
   */
  private regenerateEnergy(dtSec: number): void {
    if (!this.grounded || this.energyRegenDelayTimer > 0) return;
    this.currentEnergy = clamp(this.currentEnergy + ENERGY_REGEN_PER_SEC * dtSec, 0, ENERGY_MAX);
  }

  /** Direction the sprite should lean, for the renderer. */
  get leanDirection(): -1 | 0 | 1 {
    return sign(this.body.vx);
  }
}
