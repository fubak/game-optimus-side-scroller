/**
 * The audio engine.
 *
 * Everything is synthesised at runtime — there are no audio files anywhere in
 * the project. That keeps the single-file build genuinely self-contained, keeps
 * the download at zero bytes of samples, and means every sound can respond
 * continuously to gameplay: a footstep's timbre shifts with speed, an impact's
 * pitch drops with force, the music's intensity follows the fight.
 *
 * ## Structure
 *
 * ```
 *   sources -> bus (sfx | music | ambient | ui) -> master -> limiter -> out
 * ```
 *
 * The limiter is not optional. Layered synthesis peaks unpredictably, and a
 * dozen simultaneous impacts will clip hard without one — which is by far the
 * most common way procedural audio ends up sounding cheap.
 *
 * ## Autoplay
 *
 * Browsers refuse to start an AudioContext without a user gesture. The engine
 * therefore constructs in a suspended state and resumes on the first input,
 * rather than failing silently and leaving a permanently mute game.
 */

export const enum Bus {
  Sfx = 0,
  Music = 1,
  Ambient = 2,
  Ui = 3,
}

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  ambient: number;
  ui: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.85,
  sfx: 1.0,
  music: 0.6,
  ambient: 0.7,
  ui: 0.8,
};

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  private readonly buses: GainNode[] = [];
  private readonly reverb: ConvolverNode;
  private readonly reverbSend: GainNode;

  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private started = false;
  /** True once a user gesture has unlocked playback. */
  unlocked = false;

  constructor() {
    // A modest sample rate is plenty for synthesised material and halves the
    // DSP cost, which matters because the game is already CPU-bound on the
    // simulation.
    this.context = new AudioContext({ latencyHint: 'interactive' });

    this.limiter = this.context.createDynamicsCompressor();
    // Fast attack, hard ratio: this is a safety limiter, not a mix compressor.
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.context.destination);

    this.master = this.context.createGain();
    this.master.gain.value = this.settings.master;
    this.master.connect(this.limiter);

    for (let i = 0; i < 4; i++) {
      const bus = this.context.createGain();
      bus.connect(this.master);
      this.buses.push(bus);
    }
    this.applySettings();

    // A procedurally-generated impulse response. Reverb is what makes a canyon
    // sound like a canyon rather than an anechoic void, and generating the IR
    // avoids shipping a multi-second audio file for it.
    this.reverb = this.context.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(2.6, 2.2);
    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 0.24;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);
  }

  /**
   * Builds a decaying-noise impulse response.
   *
   * Exponentially-decaying noise is a crude but effective reverb tail. The
   * early portion is shaped to be slightly denser, which reads as the hard
   * reflective rock the Ares Basin is made of.
   */
  private createImpulseResponse(seconds: number, decay: number): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.context.createBuffer(2, length, rate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      // A tiny per-channel seed offset decorrelates the two, which is what
      // makes the tail sound wide rather than centred.
      let state = 0x2f6e2b1 + channel * 0x9e3779b9;
      for (let i = 0; i < length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const noise = ((state >>> 0) / 4294967296) * 2 - 1;
        const t = i / length;
        data[i] = noise * Math.pow(1 - t, decay) * (1 - Math.exp(-t * 40));
      }
    }
    return buffer;
  }

  /** Resumes the context. Must be called from a user gesture handler. */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    try {
      await this.context.resume();
      this.unlocked = this.context.state === 'running';
    } catch {
      // A refused resume is not fatal; the game simply stays mute until the
      // next gesture.
      this.unlocked = false;
    }
  }

  get isRunning(): boolean {
    return this.context.state === 'running';
  }

  get now(): number {
    return this.context.currentTime;
  }

  busNode(bus: Bus): GainNode {
    return this.buses[bus]!;
  }

  get reverbInput(): GainNode {
    return this.reverbSend;
  }

  setSettings(settings: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.applySettings();
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  private applySettings(): void {
    this.master.gain.value = this.settings.master;
    this.buses[Bus.Sfx]!.gain.value = this.settings.sfx;
    this.buses[Bus.Music]!.gain.value = this.settings.music;
    this.buses[Bus.Ambient]!.gain.value = this.settings.ambient;
    this.buses[Bus.Ui]!.gain.value = this.settings.ui;
  }

  markStarted(): void {
    this.started = true;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  /**
   * A shared noise buffer.
   *
   * Most percussive sounds here are filtered noise. Generating a fresh buffer
   * per sound would allocate constantly during combat; one two-second buffer
   * played from a random offset is indistinguishable and free.
   */
  private noiseBufferCache: AudioBuffer | null = null;

  get noiseBuffer(): AudioBuffer {
    if (this.noiseBufferCache) return this.noiseBufferCache;

    const rate = this.context.sampleRate;
    const length = rate * 2;
    const buffer = this.context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let state = 0x1234567;
    for (let i = 0; i < length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[i] = ((state >>> 0) / 4294967296) * 2 - 1;
    }
    this.noiseBufferCache = buffer;
    return buffer;
  }

  dispose(): void {
    void this.context.close();
  }
}
