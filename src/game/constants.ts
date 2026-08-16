/**
 * Every gameplay tuning number lives here.
 *
 * Units: pixels and seconds (so `RUN_MAX_SPEED = 130` means 130 px/s ≈ 8 tiles/s). Values were
 * tuned against the 16 px tile grid: Optimus is 22 px tall, clears 3 tiles with a full jump, and
 * 2 tiles with a tapped one.
 */

// ─── Body ────────────────────────────────────────────────────────────────────────────────────────
export const PLAYER_WIDTH = 10;
export const PLAYER_HEIGHT = 22;

// ─── Horizontal movement ─────────────────────────────────────────────────────────────────────────
export const RUN_MAX_SPEED = 130;
export const RUN_ACCEL = 1000;
export const AIR_ACCEL = 700;
export const GROUND_FRICTION = 1300;
export const AIR_DRAG = 260;
/** Speed below which the run animation switches back to idle. */
export const IDLE_SPEED_THRESHOLD = 6;

// ─── Gravity & jumping ───────────────────────────────────────────────────────────────────────────
export const GRAVITY_RISING = 800;
export const GRAVITY_FALLING = 1080;
/** Gravity is softened near the apex so the top of a jump feels floaty and controllable. */
export const APEX_SPEED_WINDOW = 45;
export const APEX_GRAVITY_MULTIPLIER = 0.72;
export const MAX_FALL_SPEED = 340;
export const JUMP_SPEED = 292;
/** Releasing jump while rising cuts the remaining upward velocity to this fraction. */
export const JUMP_CUT_MULTIPLIER = 0.38;
/**
 * Floor on the cut velocity: even the shortest tap clears a full tile, so a light press is a
 * usable move rather than a stumble.
 */
export const MIN_JUMP_SPEED = 152;
/** Grace period after walking off a ledge during which a jump still works. */
export const COYOTE_TIME = 0.1;
/** A jump pressed this long before landing still fires on touchdown. */
export const JUMP_BUFFER_TIME = 0.12;

// ─── Dash ────────────────────────────────────────────────────────────────────────────────────────
export const DASH_SPEED = 320;
export const DASH_DURATION = 0.16;
export const DASH_COOLDOWN = 0.5;
export const DASH_ENERGY_COST = 14;
/** Horizontal speed retained when a dash ends, as a fraction of dash speed. */
export const DASH_EXIT_SPEED_FACTOR = 0.45;

// ─── Thrust (jetpack) ────────────────────────────────────────────────────────────────────────────
export const THRUST_ACCEL = 1500;
export const THRUST_MAX_RISE_SPEED = 190;
export const THRUST_ENERGY_DRAIN = 38;
/** Small immediate kick when thrust engages so it feels responsive. */
export const THRUST_INITIAL_BOOST = 70;
/**
 * Absolute minimum gap below the feet before the jetpack may fire immediately.
 *
 * Combined with the time-to-touchdown rule in `Player`, this keeps "tap jump just before landing"
 * feeling like a buffered jump rather than a wasted puff of thrust.
 */
export const THRUST_MIN_CLEARANCE = 10;
/** How far below the feet the ground probe looks (must exceed a full buffer window of falling). */
export const GROUND_CLEARANCE_PROBE = 64;

// ─── Energy ──────────────────────────────────────────────────────────────────────────────────────
export const ENERGY_MAX = 100;
export const ENERGY_REGEN_PER_SEC = 46;
/** Delay before energy starts refilling after being spent. */
export const ENERGY_REGEN_DELAY = 0.3;
export const ENERGY_LOW_THRESHOLD = 25;

// ─── Health & damage ─────────────────────────────────────────────────────────────────────────────
export const HEALTH_MAX = 3;
export const INVULNERABLE_TIME = 1.2;
export const HURT_CONTROL_LOCK = 0.26;
export const HURT_KNOCKBACK_X = 165;
export const HURT_KNOCKBACK_Y = -190;
/** Blink rate (Hz) of the sprite while invulnerable. */
export const INVULNERABLE_BLINK_HZ = 12;
export const DEATH_POP_SPEED = 210;
/** Time the death animation plays before the world respawns the player. */
export const DEATH_TIME = 1.15;

// ─── Combat ──────────────────────────────────────────────────────────────────────────────────────
export const STOMP_BOUNCE_SPEED = 215;
/** Extra bounce when the jump button is held during a stomp. */
export const STOMP_BOUNCE_HELD_BONUS = 45;

// ─── Feedback ────────────────────────────────────────────────────────────────────────────────────
export const FOOTSTEP_INTERVAL = 0.24;
export const LANDING_SHAKE_SPEED = 250;
export const SHAKE_LANDING = 1.4;
export const SHAKE_HURT = 4.5;
export const SHAKE_STOMP = 2.4;
export const SHAKE_DEATH = 6;

// ─── Scoring ─────────────────────────────────────────────────────────────────────────────────────
export const SCORE_ENERGY_CELL = 100;
export const SCORE_BOLT = 50;
export const SCORE_ENEMY = 150;
export const SCORE_TIME_BONUS_PER_SEC = 10;
