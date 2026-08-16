/**
 * Sound effects, synthesised per event.
 *
 * Each sound is a small graph built on demand and torn down when it finishes.
 * That sounds wasteful but is not: Web Audio nodes are cheap to construct, and
 * building per-event means every parameter can respond to what actually
 * happened — a landing's pitch drops with impact speed, a footstep's brightness
 * rises with running speed, an impact's body resonance shifts with damage.
 *
 * ## The house sound
 *
 * Optimus is a machine, so nearly everything is built from three ingredients:
 * a **servo whine** (a fast filtered sweep), a **metallic body** (a resonant
 * bandpass ringing on noise), and a **sub thump** (a pitch-dropping sine).
 * Keeping to that palette is what makes a hundred unrelated sounds feel like
 * they come from the same machine.
 */

import { AudioEngine, Bus } from './engine.ts';

/** Clamps a value into a safe audible range, guarding against NaN. */
const safe = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
};

export class Sfx {
  /** Voices currently playing, so a chaotic moment cannot exhaust the context. */
  private voices = 0;
  private static readonly MAX_VOICES = 28;

  constructor(private readonly engine: AudioEngine) {}

  private canPlay(): boolean {
    return this.engine.isRunning && this.voices < Sfx.MAX_VOICES;
  }

  private trackVoice(node: AudioScheduledSourceNode, stopAt: number): void {
    this.voices++;
    node.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
    node.stop(stopAt);
  }

  /** A burst of filtered noise: the basis of every impact and footfall. */
  private noiseBurst(options: {
    bus: Bus;
    duration: number;
    frequency: number;
    q: number;
    gain: number;
    type?: BiquadFilterType;
    sweepTo?: number;
    reverb?: number;
  }): void {
    if (!this.canPlay()) return;
    const ctx = this.engine.context;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.engine.noiseBuffer;
    // A random offset into the shared buffer, so repeated sounds never phase
    // against each other and read as a loop.
    source.loopStart = 0;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = options.type ?? 'bandpass';
    filter.frequency.setValueAtTime(safe(options.frequency, 40, 18000), now);
    filter.Q.value = safe(options.q, 0.1, 30);
    if (options.sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        safe(options.sweepTo, 40, 18000),
        now + options.duration,
      );
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    // A 4 ms attack: fast enough to read as percussive, slow enough to avoid
    // the click a hard start produces.
    gain.gain.linearRampToValueAtTime(safe(options.gain, 0, 1), now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.engine.busNode(options.bus));
    if (options.reverb) {
      const send = ctx.createGain();
      send.gain.value = options.reverb;
      gain.connect(send);
      send.connect(this.engine.reverbInput);
    }

    source.start(now, Math.random() * 1.5);
    this.trackVoice(source, now + options.duration + 0.05);
  }

  /** A pitch-dropping oscillator: the weight under an impact. */
  private thump(options: {
    bus: Bus;
    duration: number;
    from: number;
    to: number;
    gain: number;
    type?: OscillatorType;
    reverb?: number;
  }): void {
    if (!this.canPlay()) return;
    const ctx = this.engine.context;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = options.type ?? 'sine';
    osc.frequency.setValueAtTime(safe(options.from, 20, 6000), now);
    osc.frequency.exponentialRampToValueAtTime(
      safe(options.to, 20, 6000),
      now + options.duration,
    );

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(safe(options.gain, 0, 1), now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    osc.connect(gain);
    gain.connect(this.engine.busNode(options.bus));
    if (options.reverb) {
      const send = ctx.createGain();
      send.gain.value = options.reverb;
      gain.connect(send);
      send.connect(this.engine.reverbInput);
    }

    osc.start(now);
    this.trackVoice(osc, now + options.duration + 0.05);
  }

  /**
   * A servo whine: two detuned saws through a fast filter sweep.
   *
   * This is the character's signature sound. Every limb movement of any
   * significance carries one, which is most of why the rig reads as
   * motor-driven rather than animated.
   */
  private servo(options: {
    bus: Bus;
    duration: number;
    from: number;
    to: number;
    gain: number;
  }): void {
    if (!this.canPlay()) return;
    const ctx = this.engine.context;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(safe(options.from, 40, 8000), now);
    osc.frequency.exponentialRampToValueAtTime(safe(options.to, 40, 8000), now + options.duration);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = safe(options.from * 2.2, 80, 12000);
    filter.Q.value = 5.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(safe(options.gain, 0, 0.6), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.engine.busNode(options.bus));

    osc.start(now);
    this.trackVoice(osc, now + options.duration + 0.05);
  }

  // --- Game events ---------------------------------------------------------

  /** @param speed Horizontal speed in m/s, which brightens the footfall. */
  footstep(speed: number): void {
    const intensity = Math.min(speed / 8.4, 1);
    // Metal on dust: a short noise transient plus a low resonant body.
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.09 + intensity * 0.04,
      frequency: 900 + intensity * 1400,
      q: 1.1,
      gain: 0.05 + intensity * 0.09,
      sweepTo: 320,
      reverb: 0.3,
    });
    this.thump({
      bus: Bus.Sfx,
      duration: 0.1,
      from: 118 - intensity * 20,
      to: 52,
      gain: 0.06 + intensity * 0.06,
    });
    this.servo({ bus: Bus.Sfx, duration: 0.08, from: 420, to: 900, gain: 0.02 });
  }

  jump(): void {
    this.servo({ bus: Bus.Sfx, duration: 0.16, from: 300, to: 1500, gain: 0.06 });
    this.thump({ bus: Bus.Sfx, duration: 0.14, from: 160, to: 70, gain: 0.09 });
  }

  /** @param impact Impact speed in m/s. */
  land(impact: number): void {
    const intensity = Math.min(impact / 20, 1);
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.22 + intensity * 0.2,
      frequency: 700 + intensity * 900,
      q: 0.7,
      gain: 0.08 + intensity * 0.16,
      sweepTo: 180,
      reverb: 0.45,
    });
    this.thump({
      bus: Bus.Sfx,
      duration: 0.26,
      // A heavier landing starts lower and falls further: the classic cue for
      // mass.
      from: 130 - intensity * 45,
      to: 34,
      gain: 0.12 + intensity * 0.18,
      reverb: 0.3,
    });
    this.servo({ bus: Bus.Sfx, duration: 0.2, from: 900, to: 260, gain: 0.04 });
  }

  dash(): void {
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.3,
      frequency: 2600,
      q: 0.9,
      gain: 0.11,
      sweepTo: 420,
      reverb: 0.35,
    });
    this.servo({ bus: Bus.Sfx, duration: 0.24, from: 700, to: 2400, gain: 0.07 });
  }

  /** @param step Combo index; the finisher is lower and heavier. */
  attackSwing(step: number): void {
    const heavy = step === 2;
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: heavy ? 0.26 : 0.16,
      frequency: heavy ? 1800 : 2800,
      q: 1.6,
      gain: heavy ? 0.11 : 0.075,
      sweepTo: heavy ? 300 : 700,
      reverb: 0.25,
    });
    this.servo({
      bus: Bus.Sfx,
      duration: heavy ? 0.2 : 0.12,
      from: heavy ? 260 : 420,
      to: heavy ? 1200 : 1700,
      gain: 0.05,
    });
  }

  /** @param damage Damage dealt, which drives weight and pitch. */
  impact(damage: number): void {
    const intensity = Math.min(damage / 22, 1);
    // Transient, metallic ring, and sub, in that order — the anatomy of every
    // satisfying hit.
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.05,
      frequency: 4200,
      q: 0.6,
      gain: 0.12 + intensity * 0.1,
    });
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.3 + intensity * 0.25,
      frequency: 1500 - intensity * 550,
      q: 14,
      gain: 0.09 + intensity * 0.1,
      reverb: 0.4,
    });
    this.thump({
      bus: Bus.Sfx,
      duration: 0.2,
      from: 190 - intensity * 70,
      to: 45,
      gain: 0.11 + intensity * 0.14,
      reverb: 0.25,
    });
  }

  enemyDeath(): void {
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.5,
      frequency: 2400,
      q: 0.5,
      gain: 0.16,
      sweepTo: 140,
      reverb: 0.6,
    });
    this.thump({ bus: Bus.Sfx, duration: 0.45, from: 220, to: 30, gain: 0.16, reverb: 0.4 });
    // A dying electrical whine, falling away.
    this.servo({ bus: Bus.Sfx, duration: 0.42, from: 1800, to: 180, gain: 0.06 });
  }

  playerHurt(): void {
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.32,
      frequency: 800,
      q: 3.5,
      gain: 0.15,
      sweepTo: 240,
      reverb: 0.3,
    });
    this.thump({ bus: Bus.Sfx, duration: 0.24, from: 150, to: 48, gain: 0.14 });
  }

  /** The drone's warning chirp, so the telegraph is audible as well as visible. */
  droneAlert(): void {
    this.servo({ bus: Bus.Sfx, duration: 0.22, from: 900, to: 1900, gain: 0.045 });
  }

  droneLunge(): void {
    this.noiseBurst({
      bus: Bus.Sfx,
      duration: 0.2,
      frequency: 3000,
      q: 2.2,
      gain: 0.07,
      sweepTo: 900,
    });
  }

  uiSelect(): void {
    this.thump({ bus: Bus.Ui, duration: 0.08, from: 880, to: 1320, gain: 0.06, type: 'triangle' });
  }
}
