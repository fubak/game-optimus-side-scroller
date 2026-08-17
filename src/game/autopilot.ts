import type { Action, Input } from '../core/input';
import { PLAYER_HEIGHT, RUN_MAX_SPEED } from './constants';
import { CRUSHER_WINDUP_TIME } from './enemies';
import { isStandable } from './levelParser';
import { TileKind } from './tiles';
import type { World } from './world';

/**
 * Autopilot: a greedy platforming AI that plays the game through the normal {@link Input} interface.
 *
 * It has two jobs:
 * 1. **Attract mode.** The title screen demos the game by letting the autopilot play a level, and
 *    `?autoplay=1` runs a level hands-free (handy for demos and for recording footage).
 * 2. **Level validation.** The level tests assert the autopilot can reach the goal, which proves a
 *    level is traversable with the movement set. It also hammers the controls every frame, so it
 *    doubles as a stress test for the player state machine.
 *
 * It reads the tiles around Optimus and decides what to hold: run right, jump for pits, steps,
 * spike beds and enemies, and fire the jetpack when falling into a bottomless column. It plays the
 * ground route and ignores optional collectables — it is a demo, not a speedrunner.
 */
export class Autopilot implements Input {
  private readonly world: World;
  private readonly held = new Set<Action>();
  private readonly pressedThisFrame = new Set<Action>();
  private readonly previous = new Set<Action>();
  private jumpHoldFrames = 0;
  private jumpCooldown = 0;
  private stuckFrames = 0;
  private backUpFrames = 0;
  private rescueFrames = 0;
  private lastX = 0;
  /**
   * Latched once the player first steps into the boss bay.
   *
   * Without it the autopilot flip-flopped on the threshold: boss mode told it to retreat, retreating
   * took it out of the bay, normal mode ran it straight back in, and it died in the doorway forever.
   */
  private bossEngaged = false;

  constructor(world: World) {
    this.world = world;
    this.lastX = world.player.body.x;
    this.decide();
  }

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  justPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  justReleased(action: Action): boolean {
    return this.previous.has(action) && !this.held.has(action);
  }

  anyJustPressed(): boolean {
    return this.pressedThisFrame.size > 0;
  }

  endFrame(): void {
    this.previous.clear();
    for (const action of this.held) this.previous.add(action);
    this.decide();
  }

  /**
   * Hold jump for `frames`, then guarantee a release gap before the next press.
   *
   * The player only jumps on a *fresh* press. Re-arming on the same frame the hold expired kept the
   * button down forever, which looked like the bot standing on the boss doing nothing.
   */
  private armJump(frames: number): void {
    this.jumpHoldFrames = frames;
    this.jumpCooldown = frames + 6;
  }

  private set(action: Action, down: boolean): void {
    if (down) {
      if (!this.held.has(action)) this.pressedThisFrame.add(action);
      this.held.add(action);
    } else {
      this.held.delete(action);
    }
  }

  /** Has the player entered the boss' bay (i.e. is the fight on)? Latches until the boss dies. */
  private isInsideArena(boss: { patrolMinX: number; patrolMaxX: number }): boolean {
    const playerX = this.world.player.body.x;
    if (playerX > boss.patrolMinX - 24 && playerX < boss.patrolMaxX + 24) {
      this.bossEngaged = true;
    }
    return this.bossEngaged;
  }

  private decide(): void {
    this.pressedThisFrame.clear();
    const { player, map } = this.world;
    const body = player.body;
    const tileSize = map.tileSize;

    if (this.jumpHoldFrames > 0) this.jumpHoldFrames -= 1;
    if (this.jumpCooldown > 0) this.jumpCooldown -= 1;
    if (this.backUpFrames > 0) this.backUpFrames -= 1;

    // Progress watchdog: back up and retry if we stop making ground.
    if (player.isOnGround && Math.abs(body.x - this.lastX) < 0.4) {
      this.stuckFrames += 1;
    } else {
      this.stuckFrames = 0;
    }
    this.lastX = body.x;
    if (this.stuckFrames > 24) {
      this.backUpFrames = 20;
      this.stuckFrames = 0;
    }

    // Tile coordinates: leading edge for obstacle checks, centre for floor checks.
    const footTy = Math.floor((body.y + PLAYER_HEIGHT + 1) / tileSize);
    const leadTx = Math.floor((body.x + body.width - 1) / tileSize);
    const centerTx = Math.floor((body.x + body.width / 2) / tileSize);

    const standable = (tx: number, ty: number): boolean => isStandable(map, tx, ty);
    const spike = (tx: number, ty: number): boolean => map.tileAt(tx, ty) === TileKind.Spike;

    /** Is there floor to land on in this column, at or slightly below foot level? */
    const hasFloor = (tx: number): boolean =>
      standable(tx, footTy) || standable(tx, footTy + 1) || standable(tx, footTy + 2);

    /** Is this column bottomless, i.e. is falling here fatal no matter how far we drop? */
    const bottomless = (tx: number): boolean => {
      for (let ty = Math.max(0, footTy); ty < map.height; ty += 1) {
        if (standable(tx, ty)) return false;
      }
      return true;
    };

    // Look ahead up to three tiles for pits and spikes; both want an early launch.
    const pitAt1 = !hasFloor(leadTx + 1);
    const pitAt2 = !hasFloor(leadTx + 2);
    const pitWidth = pitAt1 ? (pitAt2 ? (!hasFloor(leadTx + 3) ? 3 : 2) : 1) : 0;
    const spikesAhead =
      spike(leadTx + 1, footTy - 1) || spike(leadTx + 2, footTy - 1) || spike(leadTx + 3, footTy - 1);
    const stepAhead = standable(leadTx + 1, footTy - 1) || standable(leadTx + 1, footTy - 2);
    const tallStep = standable(leadTx + 1, footTy - 2);

    // Enemies: jump when one is close ahead. Landing on it is a stomp; missing is still a dodge.
    const enemyAhead = this.world.enemies.some((enemy) => {
      if (enemy.state !== 'active') return false;
      const gap = enemy.body.x + enemy.body.width / 2 - (body.x + body.width / 2);
      const sameLevel = Math.abs(enemy.body.y + enemy.body.height - (body.y + PLAYER_HEIGHT)) < 30;
      return sameLevel && gap > 0 && gap < 34;
    });

    // Incoming fire: turret bolts fly horizontally at body height, so a hop clears them.
    const boltIncoming = this.world.projectiles.all.some((projectile) => {
      if (!projectile.active) return false;
      const gap = projectile.x - (body.x + body.width / 2);
      const closing = projectile.vx < 0 ? gap > 0 : gap < 0;
      // Bolts are aimed, so they arrive at an angle; only dodge the ones heading for the torso.
      const nearHeight = Math.abs(projectile.y - (body.y + PLAYER_HEIGHT * 0.5)) < 18;
      return closing && nearHeight && Math.abs(gap) < 46;
    });

    /*
     * Presses: "can I make it across before that comes down?"
     *
     * The press is safe to enter only while it is parked at the top with enough of its rest phase
     * left to sprint the full width of its shadow. Otherwise the autopilot waits just outside.
     */
    const pressBlocking = this.world.enemies.some((enemy) => {
      if (enemy.kind !== 'crusher' || enemy.state !== 'active') return false;
      const shadowLeft = enemy.body.x - 8;
      const shadowRight = enemy.body.x + enemy.body.width + 4;
      const approaching = body.x + body.width > shadowLeft - 30 && body.x < shadowLeft;
      if (!approaching) return false;
      const parked = !enemy.lethal && enemy.body.y <= enemy.homeY + 1;
      if (!parked) return true;
      const timeToSlam = enemy.timer + CRUSHER_WINDUP_TIME;
      const crossingTime = (shadowRight - body.x) / RUN_MAX_SPEED;
      return timeToSlam < crossingTime + 0.2;
    });
    // Never jump into the underside of a press that is coming down.
    const crusherOverhead = this.world.enemies.some((enemy) => {
      if (enemy.kind !== 'crusher' || enemy.state !== 'active') return false;
      const overlapsColumn =
        body.x + body.width > enemy.body.x - 4 && body.x < enemy.body.x + enemy.body.width + 4;
      return overlapsColumn && enemy.body.y < body.y && (enemy.lethal || enemy.body.y > enemy.homeY + 2);
    });

    if (player.isOnGround && this.jumpCooldown === 0 && this.backUpFrames === 0) {
      if (boltIncoming) {
        this.armJump(16);
      } else if (enemyAhead) {
        this.armJump(14);
      } else if (pitAt1 || spikesAhead || stepAhead) {
        // Hold longer for the harder obstacles; the player only gains height while jump is held.
        this.armJump(pitWidth >= 2 || tallStep || spikesAhead ? 20 : 12);
      }
    }

    // Mid-air rescue: falling into a genuinely bottomless column. "Far above the ground" must not
    // count, or the bot would thrust at the top of every jump and fly along the ceiling. Bounded so
    // it cannot hover forever when a level really has no way out (that should end as a death).
    const falling = !player.isOnGround && body.vy > 40;
    const voidBelow = bottomless(centerTx);
    if (falling && voidBelow && player.energy > 6 && this.rescueFrames < 90) {
      this.rescueFrames += 1;
    } else if (player.isOnGround) {
      this.rescueFrames = 0;
    }
    const rescuing = falling && voidBelow && this.rescueFrames > 0 && this.rescueFrames < 90;

    /*
     * Boss mode.
     *
     * While the Overseer is alive the goal is the boss, not the exit: close in and stomp the core
     * during its exposed window, and back off out of its column while it is armed. This overrides
     * the terrain rules — the arena floor is flat, so there is nothing else to negotiate.
     */
    const boss = this.world.boss;
    if (boss !== null && boss.state === 'active' && this.isInsideArena(boss)) {
      const bossCenter = boss.body.x + boss.body.width / 2;
      const playerCenter = body.x + body.width / 2;
      const gap = bossCenter - playerCenter;
      const exposed = this.world.isBossVulnerable(boss);

      if (exposed) {
        // Line up on the core, then hop onto it (a stomp needs a descending landing).
        this.set('right', gap > 6);
        this.set('left', gap < -6);
        const lined = Math.abs(gap) < 26;
        if (lined && player.isOnGround && this.jumpCooldown === 0) {
          this.armJump(12);
        }
        this.set('jump', this.jumpHoldFrames > 0);
        // Dash to close the distance: the exposed window is short.
        this.set('dash', Math.abs(gap) > 90 && player.isOnGround);
        this.set('down', false);
        return;
      }

      // Anything else wandering into the waiting spot still needs stomping.
      const minionClose = this.world.enemies.some((other) => {
        if (other === boss || other.state !== 'active') return false;
        const otherGap = other.body.x + other.body.width / 2 - playerCenter;
        return Math.abs(otherGap) < 34 && Math.abs(other.body.y - body.y) < 30;
      });
      if (minionClose && player.isOnGround && this.jumpCooldown === 0) {
        this.armJump(12);
      }

      // Armed: retreat out of the bay door, where the wall breaks its line of fire, and wait for
      // the core to open. Standing in the open trading hits with a boss is how bots die.
      // Far enough back that the bay wall blocks the boss' downward line of fire.
      const safeX = boss.patrolMinX - 130;
      const towardsSafety = safeX - body.x;
      this.set('right', towardsSafety > 8);
      this.set('left', towardsSafety < -8);
      this.set('jump', this.jumpHoldFrames > 0 || (boltIncoming && player.isOnGround));
      this.set('dash', false);
      this.set('down', false);
      return;
    }

    // Wait rather than walk into a descending press.
    const waiting = pressBlocking && player.isOnGround;
    const goingBack = this.backUpFrames > 0;
    this.set('right', !goingBack && !waiting);
    this.set('left', goingBack);
    // Never jump into the underside of a press.
    this.set('jump', (this.jumpHoldFrames > 0 && !crusherOverhead) || rescuing);
    // A dash helps cross a wide pit once airborne and past the apex.
    this.set('dash', pitWidth >= 3 && !player.isOnGround && body.vy > 0);
    this.set('down', false);
  }
}
