/**
 * Ambient beds and adaptive music.
 *
 * Both are continuous generative graphs rather than looping clips, so they
 * never repeat audibly and can respond to gameplay without a crossfade seam.
 *
 * The music is layered: a drone, a pad, and a percussive pulse, each with its
 * own gain that the game raises and lowers. "Combat music" is not a different
 * track — it is the same material with the upper layers brought in, so the
 * transition is instant and seamless in both directions. Swapping between two
 * finished tracks is the usual approach and always announces itself.
 */

import { AudioEngine, Bus } from './engine.ts';
import { damp } from '../core/math/scalar.ts';

/** Minor-ish scale in semitones, giving the biome its cold, unresolved colour. */
const SCALE = [0, 3, 5, 7, 10, 12, 15];

const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

export class Ambience {
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private droneOscillators: OscillatorNode[] = [];
  private droneGain: GainNode | null = null;
  private padGain: GainNode | null = null;
  private pulseGain: GainNode | null = null;

  private started = false;
  private time = 0;
  private nextPadAt = 0;
  private nextPulseAt = 0;

  /** 0 = exploring, 1 = full combat. Smoothed internally. */
  private intensityTarget = 0;
  private intensity = 0;

  /** Root note of the current key. */
  private root = 45;

  constructor(private readonly engine: AudioEngine) {}

  /** Builds the continuous graph. Safe to call more than once. */
  start(): void {
    if (this.started || !this.engine.isRunning) return;
    this.started = true;

    const ctx = this.engine.context;

    // --- Wind bed ----------------------------------------------------------
    // Looping noise through a slowly-modulated bandpass. Two modulators at
    // incommensurate rates keep it from settling into an audible cycle.
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = this.engine.noiseBuffer;
    this.windSource.loop = true;

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480;
    this.windFilter.Q.value = 0.7;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.055;

    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.engine.busNode(Bus.Ambient));
    // A little reverb send, so the wind sounds like it is moving through a
    // canyon rather than past a microphone.
    const windSend = ctx.createGain();
    windSend.gain.value = 0.35;
    this.windGain.connect(windSend);
    windSend.connect(this.engine.reverbInput);
    this.windSource.start();

    // --- Music layers ------------------------------------------------------
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.06;
    this.droneGain.connect(this.engine.busNode(Bus.Music));

    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padGain.connect(this.engine.busNode(Bus.Music));
    const padSend = ctx.createGain();
    padSend.gain.value = 0.5;
    this.padGain.connect(padSend);
    padSend.connect(this.engine.reverbInput);

    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    this.pulseGain.connect(this.engine.busNode(Bus.Music));

    // The sustained root drone: two oscillators detuned against each other,
    // which produces a slow beating that keeps a held note alive.
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToHz(this.root - 12);
      osc.detune.value = detune;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 240;
      filter.Q.value = 1.2;

      osc.connect(filter);
      filter.connect(this.droneGain);
      osc.start();
      this.droneOscillators.push(osc);
    }
  }

  /** Sets the musical intensity target, in [0, 1]. */
  setIntensity(value: number): void {
    this.intensityTarget = Math.min(Math.max(value, 0), 1);
  }

  update(dt: number): void {
    if (!this.started || !this.engine.isRunning) return;

    this.time += dt;
    // Rising fast and falling slowly: combat should feel like it arrives
    // suddenly and releases gradually, not like a switch being flipped twice.
    const halfLife = this.intensityTarget > this.intensity ? 0.35 : 2.4;
    this.intensity = damp(this.intensity, this.intensityTarget, halfLife, dt);

    const ctx = this.engine.context;
    const now = ctx.currentTime;

    // Wind breathes on its own slow cycle, independent of gameplay.
    if (this.windFilter && this.windGain) {
      const sweep = 420 + Math.sin(this.time * 0.19) * 210 + Math.sin(this.time * 0.07) * 120;
      this.windFilter.frequency.setTargetAtTime(sweep, now, 0.4);
      this.windGain.gain.setTargetAtTime(0.045 + Math.sin(this.time * 0.11) * 0.018, now, 0.5);
    }

    if (this.padGain) {
      this.padGain.gain.setTargetAtTime(0.02 + this.intensity * 0.05, now, 0.3);
    }
    if (this.pulseGain) {
      this.pulseGain.gain.setTargetAtTime(this.intensity * 0.06, now, 0.25);
    }

    // --- Generative pad notes ---------------------------------------------
    if (this.time >= this.nextPadAt) {
      this.spawnPadNote();
      // Notes crowd together as intensity rises, which raises tension without
      // changing the material.
      this.nextPadAt = this.time + 3.6 - this.intensity * 2.0 + Math.random() * 1.6;
    }

    // --- Percussive pulse --------------------------------------------------
    if (this.intensity > 0.15 && this.time >= this.nextPulseAt) {
      this.spawnPulse();
      this.nextPulseAt = this.time + 0.5 - this.intensity * 0.22;
    }
  }

  /** A single slow, filtered note from the scale. */
  private spawnPadNote(): void {
    if (!this.padGain) return;
    const ctx = this.engine.context;
    const now = ctx.currentTime;

    const degree = SCALE[Math.floor(Math.random() * SCALE.length)]!;
    // Higher intensity reaches for higher notes.
    const octave = Math.random() < 0.35 + this.intensity * 0.25 ? 12 : 0;
    const frequency = midiToHz(this.root + degree + octave);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.linearRampToValueAtTime(1600 + this.intensity * 1800, now + 1.2);
    filter.Q.value = 2;

    const gain = ctx.createGain();
    const attack = 0.9 - this.intensity * 0.5;
    const duration = 4.5;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.34, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.padGain);
    osc.start(now);
    osc.stop(now + duration + 0.1);
  }

  /** A short percussive tick, the combat pulse. */
  private spawnPulse(): void {
    if (!this.pulseGain) return;
    const ctx = this.engine.context;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.engine.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400 + Math.random() * 1200;
    filter.Q.value = 3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.pulseGain);
    source.start(now, Math.random() * 1.5);
    source.stop(now + 0.2);

    // A sub on every other pulse, so the rhythm has a downbeat.
    if (Math.random() < 0.45) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(72, now);
      osc.frequency.exponentialRampToValueAtTime(38, now + 0.16);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0, now);
      subGain.gain.linearRampToValueAtTime(0.6, now + 0.006);
      subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      osc.connect(subGain);
      subGain.connect(this.pulseGain);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  }

  stop(): void {
    this.windSource?.stop();
    for (const osc of this.droneOscillators) osc.stop();
    this.droneOscillators = [];
    this.started = false;
  }
}
