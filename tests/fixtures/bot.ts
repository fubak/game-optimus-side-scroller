import type { Action, Input } from '../../src/core/input';
import { PLAYER_HEIGHT } from '../../src/game/constants';
import { isStandable } from '../../src/game/levelParser';
import { TileKind } from '../../src/game/tiles';
import type { World } from '../../src/game/world';

/**
 * A greedy platforming bot.
 *
 * It reads the tiles around Optimus and decides what to hold: run right, jump when there is a pit,
 * a step or a spike bed coming up, and fire the jetpack when it is falling with nothing underneath.
 * It is deliberately simple — if this bot can finish a level then the level is traversable with the
 * movement set, which is what the level tests assert. It also hammers the controls every frame,
 * which makes it a decent stress test for the player state machine.
 *
 * It is *not* a demo of skilled play: it ignores optional collectables and takes the ground route.
 */
export class PlatformerBot implements Input {
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

  private set(action: Action, down: boolean): void {
    if (down) {
      if (!this.held.has(action)) this.pressedThisFrame.add(action);
      this.held.add(action);
    } else {
      this.held.delete(action);
    }
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

    if (player.isOnGround && this.jumpCooldown === 0 && this.backUpFrames === 0) {
      if (pitAt1 || spikesAhead || stepAhead) {
        // Hold longer for the harder obstacles; the player only gains height while jump is held.
        this.jumpHoldFrames = pitWidth >= 2 || tallStep || spikesAhead ? 20 : 12;
        this.jumpCooldown = 8;
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

    const goingBack = this.backUpFrames > 0;
    this.set('right', !goingBack);
    this.set('left', goingBack);
    this.set('jump', this.jumpHoldFrames > 0 || rescuing);
    // A dash helps cross a wide pit once airborne and past the apex.
    this.set('dash', pitWidth >= 3 && !player.isOnGround && body.vy > 0);
    this.set('down', false);
  }
}
