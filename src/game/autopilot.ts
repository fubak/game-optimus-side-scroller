/**
 * A simple navigation autopilot.
 *
 * Recorded gameplay needs a player. Hand-timed input tapes were the obvious
 * first attempt and turned out to be a poor one: every timing is tied to the
 * exact geometry it was authored against, so moving a single ledge silently
 * breaks the capture, and the recording ends with the character stuck against a
 * wall or falling into a pit.
 *
 * This instead *plays* the game, by looking at the world the same way a player
 * would: is something blocking me, is there ground ahead, is the ledge I want
 * above me. It produces a reliable demo run through any level layout, and it
 * doubles as a smoke test — if the autopilot cannot get through a room, the
 * room probably cannot be got through.
 *
 * It is deliberately simple. It is not an AI showcase; it is a camera operator.
 */

import { aabb } from '../core/math/aabb.ts';
import { PhysicsWorld } from './physics.ts';
import { PlayerController } from './player/controller.ts';
import { Action, type InputSnapshot } from '../core/input.ts';

export interface AutopilotOptions {
  /** X position to head toward. */
  targetX: number;
  /** Held direction; +1 travels right. */
  direction: number;
  /** Whether to sprint. */
  sprint: boolean;
  /**
   * Positions of nearby hostiles, so the navigator can stop and fight.
   *
   * Passed in rather than queried, so the autopilot stays a pure input source
   * with no knowledge of the combat system.
   */
  threats?: { x: number; y: number }[];
}

export class Autopilot {
  private jumpHoldRemaining = 0;
  private dashCooldown = 0;
  /** Time spent making no horizontal progress, used to detect being stuck. */
  private stalledFor = 0;
  private lastX = 0;
  /** Throttle between attack presses. */
  private attackCooldown = 0;
  /** Seconds remaining during which jumps stay suppressed after a fight. */
  private engagedRecently = 0;
  /** Time remaining during which to steer away from a wall just kicked off. */
  private wallKickRemaining = 0;
  /** Direction to steer during that window, captured at the moment of the kick. */
  private wallKickDirection = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly player: PlayerController,
  ) {}

  /**
   * Produces the input for one step.
   *
   * @param dt Seconds since the previous step.
   */
  compute(options: AutopilotOptions, dt: number): Partial<InputSnapshot> {
    const player = this.player;
    const direction = options.direction;

    this.jumpHoldRemaining = Math.max(0, this.jumpHoldRemaining - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);

    const held: boolean[] = new Array<boolean>(16).fill(false);

    // Stop once the target is reached, so the run ends on a composed pose
    // rather than the character walking into the edge of the level.
    const reached = direction > 0 ? player.feetX >= options.targetX : player.feetX <= options.targetX;
    if (reached) {
      return { moveX: 0, moveY: 0, held };
    }

    let moveX = direction;

    // --- Engage hostiles ---------------------------------------------------
    // Stop and attack rather than running past. Attacks are thrown at melee
    // range with a brief pause between them, which also exercises the combo
    // buffering rather than mashing a single step.
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    const threat = this.nearestThreat(options, player.feetX, player.feetY);
    this.engagedRecently = threat ? 0.25 : Math.max(0, this.engagedRecently - dt);
    if (threat) {
      const gap = threat.x - player.feetX;
      const range = Math.abs(gap);

      if (range < 2.3) {
        // In range: hold position and swing. Never drift while attacking; the
        // lunge already closes distance.
        moveX = 0;
        if (this.attackCooldown <= 0) {
          held[Action.Attack] = true;
          this.attackCooldown = 0.22;
        }
        held[Action.Right] = false;
        held[Action.Left] = false;
        if (options.sprint) held[Action.Dash] = true;
        return { moveX: Math.sign(gap) * 0.01, moveY: 0, held };
      }

      if (range < 6.5) {
        // Close the distance deliberately, rather than sprinting past — but
        // never off a ledge. Fighting on a narrow platform and walking
        // backwards into a pit is otherwise the most common way a run ends.
        const step = Math.sign(gap);
        const footing = this.world.surfaceHeightAt(
          player.feetX + step * 0.8,
          player.feetY - 0.3,
          2.5,
        );
        if (footing.found || !player.grounded) moveX = step;
        else moveX = 0;
      }
    }

    // --- Look ahead --------------------------------------------------------
    // Sample the ground height at several distances rather than merely asking
    // "is something in the way". Knowing how high the ground ahead sits is what
    // allows a jump to be started early, with a run-up, instead of after the
    // character has already walked into a wall and lost all its speed.
    const feetY = player.feetY;
    const near = this.world.surfaceHeightAt(player.feetX + direction * 1.0, feetY - 0.3);
    const mid = this.world.surfaceHeightAt(player.feetX + direction * 2.2, feetY - 0.3);
    const far = this.world.surfaceHeightAt(player.feetX + direction * 3.6, feetY - 0.3);

    // A wall directly in front, as a fallback for geometry the height samples
    // cannot describe.
    const wallProbe = aabb(
      player.feetX + direction * 0.5,
      player.box.y - 0.15,
      0.16,
      player.box.hh * 0.7,
    );
    const blocked = this.world.isOverlapping(wallProbe) || player.wallSide === direction;

    // A gap is somewhere ahead with no ground within reach.
    const gapNear = !near.found;
    const gapMid = !mid.found;

    // A step up is ground ahead that is meaningfully higher than here. Only the
    // near sample triggers a jump: reacting to the mid and far samples made the
    // navigator jump continuously across flat ground whenever any higher
    // surface existed anywhere ahead of it.
    const stepUpNear = near.found && near.y < feetY - 0.45;

    // --- Stall detection ---------------------------------------------------
    // Without this the navigator can grind against a corner for ever. Treating
    // "no horizontal progress" as a reason to jump resolves nearly every case.
    if (Math.abs(player.feetX - this.lastX) < 0.02) this.stalledFor += dt;
    else this.stalledFor = 0;
    this.lastX = player.feetX;

    // --- Jump decision -----------------------------------------------------
    // Suppress jumps for a moment after disengaging. Leaving a fight and
    // immediately launching into the air was reliably overshooting the next
    // platform, because the jump fired from wherever the fight happened to end
    // rather than from the edge of the gap.
    const wantsJump =
      player.grounded &&
      this.engagedRecently <= 0 &&
      (blocked || gapNear || gapMid || stepUpNear || this.stalledFor > 0.2);

    if (wantsJump && this.jumpHoldRemaining <= 0) {
      // Hold jump rather than tapping it: variable jump height means a
      // single-frame press produces the shortest possible hop.
      this.jumpHoldRemaining = 0.3;
      this.stalledFor = 0;
    }

    // --- Wall jump ---------------------------------------------------------
    // Pressing into the wall is what sustains the slide, but the push-off has
    // to be followed by moving *away*, or the navigator immediately runs back
    // into the wall and repeats forever.
    if (player.wallSide !== 0 && !player.grounded && this.wallKickRemaining <= 0) {
      if (player.velocityY > 0.6) {
        this.jumpHoldRemaining = 0.22;
        this.wallKickRemaining = 0.28;
        // Remember which way to steer *now*, while the wall is still known.
        // Reading wallSide later is unreliable because contact is lost the
        // moment the jump pushes off.
        this.wallKickDirection = -player.wallSide;
        moveX = player.wallSide;
      }
    } else if (this.wallKickRemaining > 0) {
      moveX = this.wallKickDirection;
    }
    this.wallKickRemaining = Math.max(0, this.wallKickRemaining - dt);

    // --- Edge safety -------------------------------------------------------
    // Never walk off a ledge on foot. If there is no ground ahead and a jump is
    // not being made this frame, stop rather than stepping into the gap. This
    // is the single most common way an automated run ends, and it accounted for
    // every one of the seven respawns in the previous recording.
    if (player.grounded && this.jumpHoldRemaining <= 0 && !near.found) {
      moveX = 0;
      // Standing at an edge unable to jump is itself a stall, so let the stall
      // timer escalate into a jump rather than waiting there for ever.
      this.stalledFor += dt;
      if (this.stalledFor > 0.12) {
        this.jumpHoldRemaining = 0.3;
        this.stalledFor = 0;
      }
    }

    if (this.jumpHoldRemaining > 0) held[Action.Jump] = true;

    // --- Dash decision -----------------------------------------------------
    // Dash across long gaps, in the air, where it reads best and covers most
    // ground. Requires the gap to still be there two samples out.
    if (
      !player.grounded &&
      gapMid &&
      !far.found &&
      this.dashCooldown <= 0 &&
      player.velocityY > 0.3
    ) {
      held[Action.Dash] = true;
      this.dashCooldown = 1.1;
    }

    if (options.sprint) held[Action.Dash] = true;

    held[Action.Right] = moveX > 0;
    held[Action.Left] = moveX < 0;

    return { moveX, moveY: 0, held };
  }

  /** Nearest hostile within engagement range, or null. */
  private nearestThreat(
    options: AutopilotOptions,
    x: number,
    y: number,
  ): { x: number; y: number } | null {
    const threats = options.threats;
    if (!threats || threats.length === 0) return null;

    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (const threat of threats) {
      const distance = Math.hypot(threat.x - x, threat.y - (y - 0.9));
      // Only engage what is roughly in front and roughly level; chasing a
      // drone that has drifted overhead just stalls the run.
      if (Math.abs(threat.y - (y - 0.9)) > 2.6) continue;
      if (distance < bestDistance && distance < 7) {
        bestDistance = distance;
        best = threat;
      }
    }
    return best;
  }

  reset(): void {
    this.jumpHoldRemaining = 0;
    this.attackCooldown = 0;
    this.dashCooldown = 0;
    this.stalledFor = 0;
    this.lastX = 0;
    this.wallKickRemaining = 0;
    this.wallKickDirection = 0;
  }
}
