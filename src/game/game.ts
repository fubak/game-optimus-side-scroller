import type { Audio } from '../core/audio';
import { NullAudio } from '../core/audio';
import { CompositeInput } from '../core/input';
import type { Input } from '../core/input';
import { loadSave, recordLevelResult, saveGame, createDefaultSave } from '../core/storage';
import type { SaveData, StorageLike } from '../core/storage';
import { Hud } from '../render/hud';
import { palette, setHighContrast } from '../render/palette';
import { Autopilot } from './autopilot';
import { LEVELS } from './levels/index';
import { parseLevel } from './levelParser';
import type { LevelDef } from './levelParser';
import { MENU_ITEMS, createSceneState, isSimulating, reduceScene, showsWorld } from './scenes';
import type { SceneEvent, SceneState } from './scenes';
import { World } from './world';
import type { WorldEvent } from './world';

/**
 * The game facade.
 *
 * Owns the scene machine, the live {@link World}, the save file, the HUD and the audio, and glues
 * them together: menu input, level lifecycle, sound for world events, records and unlocks. It is
 * deliberately free of any DOM/canvas dependency so the entire game (menus included) can be driven
 * headlessly in tests; drawing is the renderer's job.
 */

export interface GameOptions {
  readonly storage?: StorageLike;
  readonly audio?: Audio;
  readonly levels?: readonly LevelDef[];
  /** Skip the title screen and start this campaign level immediately. */
  readonly startLevelIndex?: number;
  /** Let the autopilot play (demo/attract mode) instead of, or alongside, the player. */
  readonly autoplay?: boolean;
  readonly seed?: number;
}

export interface LevelSummary {
  readonly name: string;
  readonly subtitle: string;
  readonly timeSec: number;
  readonly parTimeSec: number;
  readonly score: number;
  readonly collected: number;
  readonly collectableTotal: number;
  readonly deaths: number;
  readonly bestTimeSec: number | null;
  readonly newBestTime: boolean;
  readonly newBestScore: boolean;
}

export class Game {
  readonly hud = new Hud();
  readonly audio: Audio;
  readonly levels: readonly LevelDef[];

  private sceneState: SceneState = createSceneState();
  private liveWorld: World | null = null;
  private attract: { world: World; pilot: Autopilot } | null = null;
  private autopilot: Autopilot | null = null;
  private saveData: SaveData;
  private readonly storage: StorageLike | null;
  private readonly autoplay: boolean;
  private readonly seed: number | undefined;
  private summary: LevelSummary | null = null;
  /** Cached autopilot wrapper, so the wrapped input is the one whose frame gets consumed. */
  private wrappedInput: Input | null = null;
  private wrappedFor: Input | null = null;
  private sceneTime = 0;
  private introTimer = 0;
  /** Set while the player holds the key that opened a menu, to avoid instant double-actions. */
  private menuCooldown = 0;

  /** Called when the key layout setting changes, so the host can rebind the keyboard. */
  onBindingsChanged: ((altBindings: boolean) => void) | null = null;

  constructor(options: GameOptions = {}) {
    this.levels = options.levels ?? LEVELS;
    this.audio = options.audio ?? new NullAudio();
    this.storage = options.storage ?? null;
    this.autoplay = options.autoplay ?? false;
    this.seed = options.seed;
    this.saveData = this.storage === null ? createDefaultSave() : loadSave(this.storage);
    this.audio.setMuted(this.saveData.settings.muted);
    this.audio.setVolume(this.saveData.settings.volume);
    // Themes are global (the palette object is shared), so apply the saved preference immediately.
    setHighContrast(this.saveData.settings.highContrast);

    if (options.startLevelIndex !== undefined) {
      this.startLevel(options.startLevelIndex);
    } else {
      this.enterTitle();
    }
  }

  get scene(): SceneState {
    return this.sceneState;
  }

  get world(): World | null {
    return this.liveWorld;
  }

  /** World rendered behind the title screen (attract mode), if any. */
  get attractWorld(): World | null {
    return this.attract?.world ?? null;
  }

  get save(): SaveData {
    return this.saveData;
  }

  get lastSummary(): LevelSummary | null {
    return this.summary;
  }

  get levelDef(): LevelDef | null {
    return this.levels[this.sceneState.levelIndex] ?? null;
  }

  /** Seconds since the current scene was entered (for animations and intro cards). */
  get timeInScene(): number {
    return this.sceneTime;
  }

  /** Remaining time on the level intro card. */
  get introTime(): number {
    return this.introTimer;
  }

  get showsWorldBehind(): boolean {
    return showsWorld(this.sceneState.name);
  }

  /**
   * Advance the game by one fixed step.
   *
   * `Game` owns the input frame lifecycle: it consumes the input exactly once per update, at the
   * end, whichever scene is active. Callers must not call `endFrame` themselves — doing so used to
   * mean the *playing* scene never ended a frame at all, so edge-triggered sources (the autopilot,
   * scripted tapes) silently stopped making new decisions.
   */
  update(dtSec: number, input: Input): void {
    this.sceneTime += dtSec;
    this.introTimer = Math.max(0, this.introTimer - dtSec);
    this.menuCooldown = Math.max(0, this.menuCooldown - dtSec);
    this.hud.update(dtSec);
    this.audio.update(dtSec);

    // With autoplay on, the autopilot is folded into the input *once* and the wrapper is what gets
    // stepped. Wrapping per-call and then ending the frame on the bare input left the autopilot
    // frozen on its first decision — it ran straight into the first pit, forever.
    const source = this.wrapInput(input);
    try {
      if (isSimulating(this.sceneState.name)) {
        this.updatePlaying(dtSec, source);
      } else {
        this.updateMenu(dtSec, source);
      }
    } finally {
      source.endFrame();
    }
  }

  private wrapInput(input: Input): Input {
    if (this.autopilot === null) return input;
    if (this.wrappedInput === null || this.wrappedFor !== input) {
      this.wrappedInput = new CompositeInput([input, this.autopilot]);
      this.wrappedFor = input;
    }
    return this.wrappedInput;
  }

  /** JSON-safe snapshot for tests and the browser test hooks. */
  snapshot(): Record<string, unknown> {
    return {
      scene: this.sceneState.name,
      cursor: this.sceneState.cursor,
      levelIndex: this.sceneState.levelIndex,
      unlockedIndex: this.saveData.unlockedIndex,
      completed: [...this.saveData.completed],
      world: this.liveWorld?.snapshot() ?? null,
      summary: this.summary,
    };
  }

  // ── Scene transitions ────────────────────────────────────────────────────────────────────────

  private dispatch(event: SceneEvent): void {
    const previous = this.sceneState;
    const next = reduceScene(previous, event, {
      levelCount: this.levels.length,
      unlockedIndex: this.saveData.unlockedIndex,
    });
    if (next === previous) return;
    this.sceneState = next;
    this.sceneTime = 0;

    if (previous.name !== next.name) {
      this.onSceneEntered(previous.name, next.name);
    } else if (next.name === 'playing' && previous.levelIndex !== next.levelIndex) {
      this.startLevel(next.levelIndex);
    }
  }

  private onSceneEntered(from: SceneState['name'], to: SceneState['name']): void {
    switch (to) {
      case 'playing':
        // Entering play from a menu (or restarting) always builds a fresh world.
        if (from !== 'paused') {
          this.startLevel(this.sceneState.levelIndex);
        } else {
          this.audio.setMusic(true, this.sceneState.levelIndex + 1);
        }
        break;
      case 'paused':
        this.audio.setMusic(false);
        break;
      case 'title':
        this.enterTitle();
        break;
      case 'levelComplete':
      case 'gameOver':
      case 'campaignComplete':
        this.audio.setMusic(false);
        break;
      case 'levelSelect':
      case 'howToPlay':
      case 'settings':
        break;
      default: {
        const exhaustive: never = to;
        throw new Error(`Unhandled scene: ${String(exhaustive)}`);
      }
    }
  }

  private enterTitle(): void {
    this.liveWorld = null;
    this.autopilot = null;
    this.wrappedInput = null;
    this.wrappedFor = null;
    this.summary = null;
    this.hud.clear();
    this.audio.setMusic(false);
    this.startAttract();
  }

  /** Build the attract-mode world that plays behind the title screen. */
  private startAttract(): void {
    const def = this.levels[0];
    if (def === undefined) {
      this.attract = null;
      return;
    }
    const world = new World(parseLevel(def), {
      ...(this.seed === undefined ? {} : { seed: this.seed }),
      lives: 99,
      reducedMotion: this.saveData.settings.reducedMotion,
    });
    this.attract = { world, pilot: new Autopilot(world) };
  }

  startLevel(levelIndex: number): void {
    const index = Math.max(0, Math.min(this.levels.length - 1, levelIndex));
    const def = this.levels[index];
    if (def === undefined) return;
    this.sceneState = { ...this.sceneState, name: 'playing', levelIndex: index, cursor: 0 };
    this.liveWorld = new World(parseLevel(def), {
      ...(this.seed === undefined ? {} : { seed: this.seed }),
      reducedMotion: this.saveData.settings.reducedMotion,
    });
    this.autopilot = this.autoplay ? new Autopilot(this.liveWorld) : null;
    // The wrapper points at the previous world's autopilot; drop it so it is rebuilt.
    this.wrappedInput = null;
    this.wrappedFor = null;
    this.attract = null;
    this.summary = null;
    this.hud.clear();
    this.introTimer = 2.2;
    this.sceneTime = 0;
    this.audio.setMusic(true, index + 1);
  }

  // ── Playing ─────────────────────────────────────────────────────────────────────────────────

  private updatePlaying(dtSec: number, input: Input): void {
    const world = this.liveWorld;
    if (world === null) {
      this.dispatch({ type: 'quitToTitle' });
      return;
    }

    if (input.justPressed('pause') && this.menuCooldown <= 0) {
      this.audio.play('menuBack');
      this.menuCooldown = 0.2;
      this.dispatch({ type: 'pause' });
      return;
    }
    if (input.justPressed('restart')) {
      this.audio.play('menuConfirm');
      this.startLevel(this.sceneState.levelIndex);
      return;
    }
    if (input.justPressed('mute')) {
      this.toggleMute();
    }

    const effective = this.autopilot === null ? input : new CompositeInput([input, this.autopilot]);
    const events = world.update(dtSec, effective);
    this.handleWorldEvents(events, world);

    if (world.status === 'complete') {
      this.finishLevel(world);
    } else if (world.status === 'failed') {
      this.audio.play('death');
      this.dispatch({ type: 'levelFailed' });
    }
  }

  private handleWorldEvents(events: readonly WorldEvent[], world: World): void {
    for (const event of events) {
      switch (event.type) {
        case 'player':
          this.playPlayerSound(event.event.type);
          break;
        case 'pickup':
          this.audio.play(event.kind === 'repairKit' ? 'repair' : event.kind === 'bolt' ? 'bolt' : 'pickup');
          this.hud.push(
            event.kind === 'repairKit' ? 'CHASSIS REPAIRED' : `+${String(event.score)}`,
            event.kind === 'repairKit' ? palette.health : palette.energy,
            1.1,
          );
          break;
        case 'enemyKilled':
          this.audio.play('stomp');
          this.hud.push(`SCRAPPED +${String(event.score)}`, palette.uiWarn, 1);
          break;
        case 'enemyShot':
          this.audio.play('shoot', { volume: 0.6 });
          break;
        case 'enemyHurt':
          this.audio.play('stomp');
          this.hud.push('CORE BREACHED', palette.uiWarn, 1.4);
          break;
        case 'crusherSlam':
          this.audio.play('crusher', { volume: 0.7 });
          break;
        case 'checkpoint':
          this.audio.play('checkpoint');
          this.hud.push('CHECKPOINT SYNCED', palette.visor, 1.4);
          break;
        case 'death':
          this.hud.push(
            event.livesLeft > 0
              ? `SYSTEMS OFFLINE - ${String(event.livesLeft)} CHASSIS LEFT`
              : 'LAST CHASSIS DOWN',
            palette.hazard,
            2,
          );
          break;
        case 'respawn':
          this.hud.clear();
          break;
        case 'goal':
          this.audio.play('goal');
          break;
        case 'goalLocked':
          this.audio.play('empty', { volume: 0.6 });
          this.hud.push('HATCH SEALED — SHUT DOWN THE OVERSEER', palette.uiWarn, 1.6);
          break;
        case 'failed':
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(`Unhandled world event: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    // Thrust is a continuous sound, retriggered while the jetpack burns.
    if (world.player.state === 'thrust') {
      this.audio.play('thrust', { volume: 0.5 });
    }
  }

  private playPlayerSound(type: string): void {
    switch (type) {
      case 'jump':
        this.audio.play('jump');
        break;
      case 'land':
        this.audio.play('land', { volume: 0.8 });
        break;
      case 'footstep':
        this.audio.play('footstep', { volume: 0.5 });
        break;
      case 'dash':
        this.audio.play('dash');
        break;
      case 'hurt':
        this.audio.play('hurt');
        break;
      case 'die':
        this.audio.play('death');
        break;
      case 'energyEmpty':
        this.audio.play('empty', { volume: 0.5 });
        break;
      default:
        break;
    }
  }

  private finishLevel(world: World): void {
    const def = this.levels[this.sceneState.levelIndex];
    if (def === undefined) return;
    const stats = world.stats;
    const timeMs = Math.round(stats.timeSec * 1000);
    const outcome = recordLevelResult(
      this.saveData,
      { levelId: def.id, levelIndex: this.sceneState.levelIndex, timeMs, score: stats.score },
      this.levels.length,
    );
    const previousBest = this.saveData.bestTimesMs[def.id];
    this.saveData = outcome.save;
    this.persist();

    this.summary = {
      name: def.name,
      subtitle: def.subtitle,
      timeSec: stats.timeSec,
      parTimeSec: stats.parTimeSec,
      score: stats.score,
      collected: stats.collected,
      collectableTotal: stats.collectableTotal,
      deaths: stats.deaths,
      bestTimeSec: previousBest === undefined ? null : previousBest / 1000,
      newBestTime: outcome.newBestTime,
      newBestScore: outcome.newBestScore,
    };
    this.dispatch({ type: 'levelCompleted' });
  }

  // ── Menus ───────────────────────────────────────────────────────────────────────────────────

  private updateMenu(dtSec: number, input: Input): void {
    // Attract mode keeps playing behind the title screen.
    if (this.attract !== null && this.sceneState.name === 'title') {
      const { world, pilot } = this.attract;
      world.update(dtSec, pilot);
      pilot.endFrame();
      if (world.isFinished) this.startAttract();
    }

    const vertical = (input.justPressed('down') ? 1 : 0) - (input.justPressed('up') ? 1 : 0);
    if (vertical !== 0) {
      this.audio.play('menuMove');
      this.dispatch({ type: 'moveCursor', delta: vertical });
    }

    if (this.sceneState.name === 'settings') {
      this.handleSettingsInput(input);
    }

    if (input.justPressed('mute')) this.toggleMute();

    if (input.justPressed('confirm') || input.justPressed('jump')) {
      if (this.menuCooldown <= 0) {
        this.audio.resume();
        this.audio.play('menuConfirm');
        this.menuCooldown = 0.15;
        this.dispatch({ type: 'confirm' });
      }
    } else if (input.justPressed('back') || input.justPressed('pause')) {
      if (this.menuCooldown <= 0) {
        this.audio.play('menuBack');
        this.menuCooldown = 0.15;
        this.dispatch({ type: 'back' });
      }
    }
  }

  private handleSettingsInput(input: Input): void {
    const item = MENU_ITEMS.settings[this.sceneState.cursor] ?? 'BACK';
    const horizontal = (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0);
    if (item === 'VOLUME' && horizontal !== 0) {
      const volume = Math.min(1, Math.max(0, this.saveData.settings.volume + horizontal * 0.02));
      this.saveData = { ...this.saveData, settings: { ...this.saveData.settings, volume } };
      this.audio.setVolume(volume);
      this.persist();
      return;
    }
    if (!input.justPressed('confirm') && !input.justPressed('jump')) return;
    switch (item) {
      case 'SOUND':
        this.toggleMute();
        break;
      case 'REDUCED MOTION': {
        const reducedMotion = !this.saveData.settings.reducedMotion;
        this.saveData = { ...this.saveData, settings: { ...this.saveData.settings, reducedMotion } };
        this.liveWorld?.setReducedMotion(reducedMotion);
        this.attract?.world.setReducedMotion(reducedMotion);
        this.persist();
        break;
      }
      case 'HIGH CONTRAST': {
        const highContrast = !this.saveData.settings.highContrast;
        this.saveData = { ...this.saveData, settings: { ...this.saveData.settings, highContrast } };
        setHighContrast(highContrast);
        this.persist();
        break;
      }
      case 'KEY LAYOUT': {
        const altBindings = !this.saveData.settings.altBindings;
        this.saveData = { ...this.saveData, settings: { ...this.saveData.settings, altBindings } };
        this.onBindingsChanged?.(altBindings);
        this.persist();
        break;
      }
      case 'RESET PROGRESS':
        this.saveData = { ...createDefaultSave(), settings: this.saveData.settings };
        this.persist();
        this.hud.push('PROGRESS ERASED', palette.hazard, 2);
        break;
      default:
        break;
    }
  }

  toggleMute(): void {
    const muted = !this.saveData.settings.muted;
    this.saveData = { ...this.saveData, settings: { ...this.saveData.settings, muted } };
    this.audio.setMuted(muted);
    if (!muted && isSimulating(this.sceneState.name)) {
      this.audio.setMusic(true, this.sceneState.levelIndex + 1);
    }
    this.persist();
  }

  private persist(): void {
    if (this.storage === null) return;
    saveGame(this.storage, this.saveData);
  }
}
