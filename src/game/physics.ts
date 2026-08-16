/**
 * Collision and movement resolution.
 *
 * A swept solver rather than a discrete one. The character reaches roughly
 * 20 m/s during a dash, which at a 120 Hz step is 0.17 m per step — more than
 * a third of its own body width, and easily enough to pass straight through a
 * thin platform between one step and the next. Sweeping solves for the exact
 * moment of contact instead of checking for overlap after the fact.
 *
 * The world is a list of axis-aligned solids. For a hand-authored 2D level this
 * beats a tile grid: platforms can be any size, so a long floor is one box
 * rather than forty, and the broad phase stays trivial.
 */

import { type AABB, aabb, sweepAABB, overlaps, sweptBounds, type SweepHit } from '../core/math/aabb.ts';

export const enum SolidKind {
  /** Blocks from every direction. */
  Solid = 0,
  /**
   * Blocks only from above, and only when moving downward.
   *
   * Essential for platforming: the player jumps up through these and lands on
   * top, which is what makes vertical level design readable.
   */
  OneWay = 1,
}

export interface Solid {
  box: AABB;
  kind: SolidKind;
  /** Surface angle in radians, for foot alignment. Zero is flat. */
  surfaceAngle: number;
}

export interface MoveResult {
  /** True if the mover ended the step standing on something. */
  grounded: boolean;
  /** True if it is touching a wall, and on which side (-1 left, +1 right). */
  wall: number;
  /** True if it struck a ceiling. */
  ceiling: boolean;
  /** Surface angle of the ground beneath, in radians. */
  groundAngle: number;
  /** World Y of the surface it is standing on. */
  groundY: number;
  /** Velocity after resolution; may differ from the requested velocity. */
  velocityX: number;
  velocityY: number;
}

/**
 * Distance kept between a mover and a surface after resolution.
 *
 * Resolving to exactly zero separation means the next step starts already
 * touching, and floating-point error then decides whether the sweep sees an
 * overlap. That flickers `grounded` on and off, which in turn flickers the
 * animation state and the coyote timer. A small gap makes contact unambiguous.
 */
const SKIN = 0.001;

/** How steep a surface can be before it stops counting as ground. */
const MAX_GROUND_NORMAL_Y = -0.6;

export class PhysicsWorld {
  readonly solids: Solid[] = [];

  /** Scratch objects; the movement path must not allocate. */
  private readonly hit: SweepHit = { time: 0, normalX: 0, normalY: 0 };
  private readonly broad: AABB = aabb();
  private readonly candidates: Solid[] = [];

  addSolid(x: number, y: number, width: number, height: number, kind = SolidKind.Solid, surfaceAngle = 0): Solid {
    const solid: Solid = {
      box: aabb(x, y, width / 2, height / 2),
      kind,
      surfaceAngle,
    };
    this.solids.push(solid);
    return solid;
  }

  clear(): void {
    this.solids.length = 0;
  }

  /**
   * Moves `box` by the given velocity over `dt`, resolving collisions.
   *
   * Uses iterative sweep-and-slide: find the first contact, move up to it,
   * remove the velocity component into the surface, and repeat. Four iterations
   * is enough for any corner geometry in practice, and the cap guarantees
   * termination even in a degenerate wedge.
   */
  move(box: AABB, velocityX: number, velocityY: number, dt: number, result: MoveResult): MoveResult {
    result.grounded = false;
    result.wall = 0;
    result.ceiling = false;
    result.groundAngle = 0;
    result.groundY = 0;

    let remainingX = velocityX * dt;
    let remainingY = velocityY * dt;
    let vx = velocityX;
    let vy = velocityY;

    // Push out of anything already overlapping before sweeping. A swept test
    // cannot resolve an existing overlap — it solves for the moment contact
    // *begins* — so without this a body that ends up even slightly inside
    // geometry is stuck there permanently.
    this.depenetrate(box, result);

    for (let iteration = 0; iteration < 4; iteration++) {
      if (Math.abs(remainingX) < 1e-9 && Math.abs(remainingY) < 1e-9) break;

      this.gatherCandidates(box, remainingX, remainingY);

      let earliestTime = 1;
      let earliestNormalX = 0;
      let earliestNormalY = 0;
      let earliestSolid: Solid | null = null;

      for (const solid of this.candidates) {
        // A one-way platform is only solid when approaching from above while
        // descending. Testing the *previous* bottom edge against the platform's
        // top is what allows a jump to pass up through it.
        if (solid.kind === SolidKind.OneWay) {
          if (remainingY <= 0) continue;
          const previousBottom = box.y + box.hh;
          const platformTop = solid.box.y - solid.box.hh;
          if (previousBottom > platformTop + 0.02) continue;
        }

        if (!sweepAABB(box, remainingX, remainingY, solid.box, this.hit)) continue;
        if (this.hit.time < earliestTime) {
          earliestTime = this.hit.time;
          earliestNormalX = this.hit.normalX;
          earliestNormalY = this.hit.normalY;
          earliestSolid = solid;
        }
      }

      if (!earliestSolid) {
        box.x += remainingX;
        box.y += remainingY;
        break;
      }

      // Advance to just before contact.
      box.x += remainingX * earliestTime;
      box.y += remainingY * earliestTime;
      box.x += earliestNormalX * SKIN;
      box.y += earliestNormalY * SKIN;

      if (earliestNormalY <= MAX_GROUND_NORMAL_Y) {
        result.grounded = true;
        result.groundAngle = earliestSolid.surfaceAngle;
        result.groundY = earliestSolid.box.y - earliestSolid.box.hh;
        vy = 0;
      } else if (earliestNormalY >= 0.6) {
        result.ceiling = true;
        vy = 0;
      }
      if (earliestNormalX !== 0) {
        result.wall = -earliestNormalX;
        vx = 0;
      }

      // Slide: keep the component of the remaining motion along the surface.
      const leftover = 1 - earliestTime;
      let slideX = remainingX * leftover;
      let slideY = remainingY * leftover;
      const into = slideX * earliestNormalX + slideY * earliestNormalY;
      slideX -= into * earliestNormalX;
      slideY -= into * earliestNormalY;

      remainingX = slideX;
      remainingY = slideY;
    }

    result.velocityX = vx;
    result.velocityY = vy;
    return result;
  }

  /**
   * Resolves existing overlaps by pushing along the axis of least penetration.
   *
   * Choosing the shallowest axis is what makes this feel correct: a body that
   * has sunk two centimetres into a floor is lifted two centimetres, rather
   * than being ejected sideways out of the platform it is standing on.
   */
  private depenetrate(box: AABB, result: MoveResult): void {
    for (const solid of this.solids) {
      // One-way platforms must never push a body out, or standing on one while
      // walking off its edge would fling the player sideways.
      if (solid.kind === SolidKind.OneWay) continue;
      if (!overlaps(box, solid.box)) continue;

      const overlapX = box.hw + solid.box.hw - Math.abs(box.x - solid.box.x);
      const overlapY = box.hh + solid.box.hh - Math.abs(box.y - solid.box.y);
      if (overlapX <= 0 || overlapY <= 0) continue;

      if (overlapY <= overlapX) {
        const direction = box.y < solid.box.y ? -1 : 1;
        box.y += direction * (overlapY + SKIN);
        if (direction < 0) {
          result.grounded = true;
          result.groundAngle = solid.surfaceAngle;
          result.groundY = solid.box.y - solid.box.hh;
        }
      } else {
        const direction = box.x < solid.box.x ? -1 : 1;
        box.x += direction * (overlapX + SKIN);
      }
    }
  }

  private gatherCandidates(box: AABB, dx: number, dy: number): void {
    this.candidates.length = 0;
    sweptBounds(this.broad, box, dx, dy);
    // A small margin so a solid the sweep only just grazes is not missed.
    this.broad.hw += 0.02;
    this.broad.hh += 0.02;
    for (const solid of this.solids) {
      if (overlaps(this.broad, solid.box)) this.candidates.push(solid);
    }
  }

  /**
   * Probes downward for ground.
   *
   * Used for coyote time and for foot IK, both of which need to know about a
   * surface the character is *near* rather than one it has already hit.
   */
  probeGround(box: AABB, distance: number): { hit: boolean; y: number; angle: number } {
    const probe = aabb(box.x, box.y + distance / 2, box.hw * 0.92, box.hh + distance / 2);
    let bestY = Infinity;
    let bestAngle = 0;
    let found = false;

    for (const solid of this.solids) {
      if (!overlaps(probe, solid.box)) continue;
      const top = solid.box.y - solid.box.hh;
      // Only consider surfaces at or below the mover's feet.
      if (top < box.y + box.hh - 0.05) continue;
      if (top < bestY) {
        bestY = top;
        bestAngle = solid.surfaceAngle;
        found = true;
      }
    }

    return { hit: found, y: found ? bestY : 0, angle: bestAngle };
  }

  /**
   * Finds the walkable surface height at a world X.
   *
   * Returns the topmost surface at or below `fromY`, searching down at most
   * `maxDrop` metres. Used for navigation lookahead: knowing the *height* of
   * the ground ahead, rather than merely whether some exists, is what lets a
   * navigator decide between stepping up, dropping down, and jumping a gap.
   */
  surfaceHeightAt(
    x: number,
    fromY: number,
    maxDrop = 12,
    maxRise = 3.4,
  ): { found: boolean; y: number } {
    let best = Infinity;
    for (const solid of this.solids) {
      const box = solid.box;
      if (x < box.x - box.hw || x > box.x + box.hw) continue;
      const top = box.y - box.hh;
      // Surfaces above the query point must be included, up to what a jump can
      // reach: a *step up* is precisely the case lookahead exists to detect,
      // and excluding them made every climb invisible to the navigator.
      if (top < fromY - maxRise) continue;
      if (top > fromY + maxDrop) continue;
      if (top < best) best = top;
    }
    return best === Infinity ? { found: false, y: 0 } : { found: true, y: best };
  }

  /** True if the box overlaps any solid. Used to validate spawn points. */
  isOverlapping(box: AABB): boolean {
    for (const solid of this.solids) {
      if (solid.kind === SolidKind.OneWay) continue;
      if (overlaps(box, solid.box)) return true;
    }
    return false;
  }
}

export const createMoveResult = (): MoveResult => ({
  grounded: false,
  wall: 0,
  ceiling: false,
  groundAngle: 0,
  groundY: 0,
  velocityX: 0,
  velocityY: 0,
});
