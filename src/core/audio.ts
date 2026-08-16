/**
 * Procedural audio.
 *
 * There are no audio files: every sound is synthesised with oscillators and noise buffers at play
 * time, and the music is a scheduled arpeggio. That keeps the repo asset-free, makes the "sound
 * design" a set of tunable numbers, and means the whole thing is a few kB of code.
 *
 * The `Audio` interface exists so headless tests and the simulation can run with {@link NullAudio}
 * (Node has no `AudioContext`), and so the real context is only created after a user gesture, as
 * browsers require.
 */

export type SoundName =
  | 'jump'
  | 'land'
  | 'footstep'
  | 'dash'
  | 'thrust'
  | 'stomp'
  | 'hurt'
  | 'death'
  | 'pickup'
  | 'bolt'
  | 'repair'
  | 'checkpoint'
  | 'goal'
  | 'shoot'
  | 'crusher'
  | 'menuMove'
  | 'menuConfirm'
  | 'menuBack'
  | 'empty';

export interface Audio {
  play(sound: SoundName, options?: { readonly volume?: number; readonly rate?: number }): void;
  /** Start/stop the looping music bed. */
  setMusic(enabled: boolean, seed?: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  /** Called on the first user gesture to unlock the audio context. */
  resume(): void;
  /** Advance any scheduled music. Called once per frame. */
  update(dtSec: number): void;
  dispose(): void;
}

/** Silent implementation used in tests, headless runs and before audio is unlocked. */
export class NullAudio implements Audio {
  private muted = false;
  private volume = 0.7;

  play(_sound: SoundName, _options?: { readonly volume?: number; readonly rate?: number }): void {
    /* silence */
  }

  setMusic(_enabled: boolean, _seed?: number): void {
    /* silence */
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  getVolume(): number {
    return this.volume;
  }

  resume(): void {
    /* nothing to unlock */
  }

  update(_dtSec: number): void {
    /* nothing scheduled */
  }

  dispose(): void {
    /* nothing to release */
  }
}

interface SoundSpec {
  readonly type: OscillatorType;
  /** Start frequency in Hz. */
  readonly from: number;
  /** End frequency in Hz (a sweep when different from `from`). */
  readonly to: number;
  readonly duration: number;
  readonly gain: number;
  /** Mix in a burst of filtered noise (impacts, thrusters). */
  readonly noise?: number;
  /** Square-wave detune partner for a fuller, more "electronic" tone. */
  readonly detune?: number;
  /** Low-pass cutoff applied to the noise component. */
  readonly noiseCutoff?: number;
}

const SOUNDS: Readonly<Record<SoundName, SoundSpec>> = {
  jump: { type: 'square', from: 320, to: 620, duration: 0.16, gain: 0.22, detune: 8 },
  land: { type: 'sine', from: 180, to: 90, duration: 0.12, gain: 0.2, noise: 0.25, noiseCutoff: 900 },
  footstep: { type: 'sine', from: 120, to: 90, duration: 0.05, gain: 0.06, noise: 0.2, noiseCutoff: 1400 },
  dash: { type: 'sawtooth', from: 620, to: 220, duration: 0.2, gain: 0.18, noise: 0.35, noiseCutoff: 2600 },
  thrust: { type: 'sawtooth', from: 90, to: 140, duration: 0.18, gain: 0.1, noise: 0.5, noiseCutoff: 1800 },
  stomp: { type: 'square', from: 220, to: 70, duration: 0.18, gain: 0.26, noise: 0.4, noiseCutoff: 1200 },
  hurt: { type: 'square', from: 260, to: 120, duration: 0.26, gain: 0.28, detune: -30 },
  death: { type: 'sawtooth', from: 340, to: 60, duration: 0.7, gain: 0.3, detune: -20 },
  pickup: { type: 'square', from: 660, to: 990, duration: 0.14, gain: 0.18 },
  bolt: { type: 'square', from: 880, to: 1180, duration: 0.09, gain: 0.14 },
  repair: { type: 'sine', from: 520, to: 780, duration: 0.3, gain: 0.2 },
  checkpoint: { type: 'sine', from: 440, to: 880, duration: 0.35, gain: 0.2 },
  goal: { type: 'square', from: 520, to: 1040, duration: 0.5, gain: 0.24 },
  shoot: { type: 'square', from: 420, to: 260, duration: 0.1, gain: 0.12 },
  crusher: { type: 'sawtooth', from: 120, to: 40, duration: 0.35, gain: 0.3, noise: 0.5, noiseCutoff: 700 },
  menuMove: { type: 'square', from: 520, to: 520, duration: 0.05, gain: 0.1 },
  menuConfirm: { type: 'square', from: 620, to: 880, duration: 0.12, gain: 0.16 },
  menuBack: { type: 'square', from: 440, to: 300, duration: 0.1, gain: 0.14 },
  empty: { type: 'square', from: 200, to: 140, duration: 0.12, gain: 0.12 },
};

/** Pentatonic-ish scale (semitones) that always sounds vaguely intentional. */
const SCALE = [0, 3, 5, 7, 10, 12, 15];
const MUSIC_ROOT_HZ = 110;
const MUSIC_STEP_SEC = 0.22;

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContext(): AudioContextConstructor | null {
  const candidate = (globalThis as { AudioContext?: AudioContextConstructor }).AudioContext;
  return candidate ?? null;
}

export class WebAudio implements Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private volume = 0.7;
  private musicEnabled = false;
  private musicSeed = 1;
  private musicStep = 0;
  private nextNoteTime = 0;
  /** Rate limit so a burst of identical events cannot stack into a click. */
  private readonly lastPlayed = new Map<SoundName, number>();
  private elapsed = 0;

  play(sound: SoundName, options: { readonly volume?: number; readonly rate?: number } = {}): void {
    if (this.muted) return;
    const context = this.ensureContext();
    if (context === null || this.master === null) return;

    const previous = this.lastPlayed.get(sound) ?? -1;
    if (this.elapsed - previous < 0.03) return;
    this.lastPlayed.set(sound, this.elapsed);

    const spec = SOUNDS[sound];
    const rate = options.rate ?? 1;
    const now = context.currentTime;
    const duration = spec.duration / rate;
    const gainValue = spec.gain * (options.volume ?? 1);

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    envelope.connect(this.master);

    const oscillator = context.createOscillator();
    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(spec.from * rate, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to * rate), now + duration);
    oscillator.connect(envelope);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);

    if (spec.detune !== undefined) {
      const partner = context.createOscillator();
      partner.type = spec.type;
      partner.detune.setValueAtTime(spec.detune, now);
      partner.frequency.setValueAtTime(spec.from * rate, now);
      partner.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to * rate), now + duration);
      partner.connect(envelope);
      partner.start(now);
      partner.stop(now + duration + 0.02);
    }

    if (spec.noise !== undefined) {
      const buffer = this.ensureNoiseBuffer(context);
      if (buffer !== null) {
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(spec.noiseCutoff ?? 1200, now);
        const noiseGain = context.createGain();
        noiseGain.gain.setValueAtTime(gainValue * spec.noise, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        noise.connect(filter).connect(noiseGain).connect(this.master);
        noise.start(now);
        noise.stop(now + duration + 0.02);
      }
    }
  }

  setMusic(enabled: boolean, seed = 1): void {
    this.musicEnabled = enabled;
    this.musicSeed = seed;
    if (enabled) {
      this.musicStep = 0;
      const context = this.ensureContext();
      this.nextNoteTime = context === null ? 0 : context.currentTime;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== null && this.context !== null) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.context.currentTime, 0.02);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master !== null && this.context !== null && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  resume(): void {
    const context = this.ensureContext();
    if (context === null) return;
    if (context.state === 'suspended') {
      void context.resume();
    }
  }

  update(dtSec: number): void {
    this.elapsed += dtSec;
    if (!this.musicEnabled || this.muted) return;
    const context = this.context;
    if (context === null) return;
    // Schedule a little ahead of the clock so the loop never stutters on a busy frame.
    while (this.nextNoteTime < context.currentTime + 0.25) {
      this.scheduleMusicNote(context, this.nextNoteTime);
      this.nextNoteTime += MUSIC_STEP_SEC;
      this.musicStep += 1;
    }
  }

  dispose(): void {
    this.musicEnabled = false;
    if (this.context !== null) {
      void this.context.close();
      this.context = null;
      this.master = null;
      this.noiseBuffer = null;
    }
  }

  private scheduleMusicNote(context: AudioContext, when: number): void {
    if (this.master === null) return;
    const step = this.musicStep;
    // Deterministic pattern from the seed: an ostinato bass with an occasional high accent.
    const patternIndex = (step * 5 + this.musicSeed) % SCALE.length;
    const semitone = SCALE[patternIndex] ?? 0;
    const octave = step % 8 === 0 ? 2 : step % 4 === 2 ? 1 : 0;
    const frequency = MUSIC_ROOT_HZ * Math.pow(2, (semitone + octave * 12) / 12);

    const envelope = context.createGain();
    const peak = step % 4 === 0 ? 0.075 : 0.045;
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(peak, when + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + MUSIC_STEP_SEC * 0.9);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(step % 8 === 0 ? 1800 : 900, when);
    envelope.connect(filter).connect(this.master);

    const oscillator = context.createOscillator();
    oscillator.type = step % 8 === 0 ? 'square' : 'triangle';
    oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.connect(envelope);
    oscillator.start(when);
    oscillator.stop(when + MUSIC_STEP_SEC);
  }

  private ensureContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    const Constructor = resolveAudioContext();
    if (Constructor === null) return null;
    const context = new Constructor();
    const master = context.createGain();
    master.gain.setValueAtTime(this.muted ? 0 : this.volume, context.currentTime);
    master.connect(context.destination);
    this.context = context;
    this.master = master;
    this.nextNoteTime = context.currentTime;
    return context;
  }

  private ensureNoiseBuffer(context: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer !== null) return this.noiseBuffer;
    const length = Math.floor(context.sampleRate * 0.4);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic noise: a fixed LCG rather than Math.random, so runs sound identical.
    let state = 22222;
    for (let i = 0; i < length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (state / 0x3fffffff - 1) * (1 - i / length);
    }
    this.noiseBuffer = buffer;
    return buffer;
  }
}

/** Pick the best available implementation for the current environment. */
export function createAudio(): Audio {
  return resolveAudioContext() === null ? new NullAudio() : new WebAudio();
}
