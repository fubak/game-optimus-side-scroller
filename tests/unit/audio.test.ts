import { describe, expect, it, vi } from 'vitest';
import { NullAudio, WebAudio, createAudio } from '../../src/core/audio';

/**
 * Audio tests.
 *
 * Node has no `AudioContext`, so these cover two things: the null implementation behaves sanely (it
 * is what the simulation and tests use), and `WebAudio` degrades gracefully rather than throwing
 * when the API is missing — plus a minimal fake context proves the synthesis path wires nodes up.
 */

describe('NullAudio', () => {
  it('accepts every call and tracks mute/volume', () => {
    const audio = new NullAudio();
    expect(() => audio.play('jump')).not.toThrow();
    expect(() => audio.setMusic(true, 3)).not.toThrow();
    expect(() => audio.update(1 / 60)).not.toThrow();
    expect(() => audio.resume()).not.toThrow();
    expect(() => audio.dispose()).not.toThrow();
    audio.setMuted(true);
    expect(audio.isMuted()).toBe(true);
    audio.setVolume(0.25);
    expect(audio.getVolume()).toBe(0.25);
  });
});

describe('createAudio', () => {
  it('falls back to silence when the Web Audio API is missing', () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    const audio = createAudio();
    expect(audio).toBeInstanceOf(NullAudio);
    if (original !== undefined) {
      (globalThis as { AudioContext?: unknown }).AudioContext = original;
    }
  });
});

describe('WebAudio without a context', () => {
  it('never throws when the API is unavailable', () => {
    const audio = new WebAudio();
    expect(() => audio.play('stomp')).not.toThrow();
    expect(() => audio.setMusic(true)).not.toThrow();
    expect(() => audio.update(1 / 60)).not.toThrow();
    expect(() => audio.resume()).not.toThrow();
    audio.setMuted(true);
    expect(audio.isMuted()).toBe(true);
    audio.setVolume(2);
    expect(audio.getVolume()).toBe(1);
    audio.setVolume(-1);
    expect(audio.getVolume()).toBe(0);
    expect(() => audio.dispose()).not.toThrow();
  });
});

/** The smallest fake that satisfies the code path: nodes that record connections. */
function fakeAudioContext(): { Constructor: new () => AudioContext; created: () => number } {
  let oscillators = 0;
  const param = (): AudioParam =>
    ({
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
    }) as unknown as AudioParam;
  const node = (): AudioNode =>
    ({
      connect: vi.fn((destination: AudioNode) => destination),
      disconnect: vi.fn(),
    }) as unknown as AudioNode;

  class FakeContext {
    currentTime = 0;
    sampleRate = 44100;
    state: AudioContextState = 'running';
    // Only used as a connect() target, so a bare node is enough.
    destination = node();

    createGain(): GainNode {
      return { ...node(), gain: param() };
    }

    createOscillator(): OscillatorNode {
      oscillators += 1;
      return {
        ...node(),
        type: 'sine' as OscillatorType,
        frequency: param(),
        detune: param(),
        start: vi.fn(),
        stop: vi.fn(),
      } as unknown as OscillatorNode;
    }

    createBiquadFilter(): BiquadFilterNode {
      return {
        ...node(),
        type: 'lowpass' as BiquadFilterType,
        frequency: param(),
      } as unknown as BiquadFilterNode;
    }

    createBufferSource(): AudioBufferSourceNode {
      return { ...node(), buffer: null, start: vi.fn(), stop: vi.fn() } as unknown as AudioBufferSourceNode;
    }

    createBuffer(_channels: number, length: number): AudioBuffer {
      const data = new Float32Array(length);
      return { getChannelData: () => data, length } as unknown as AudioBuffer;
    }

    resume(): Promise<void> {
      this.state = 'running';
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  return { Constructor: FakeContext as unknown as new () => AudioContext, created: () => oscillators };
}

describe('WebAudio with a context', () => {
  it('synthesises sounds and schedules music deterministically', () => {
    const fake = fakeAudioContext();
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = fake.Constructor;
    try {
      const audio = createAudio();
      expect(audio).toBeInstanceOf(WebAudio);
      audio.play('jump');
      expect(fake.created()).toBeGreaterThan(0);

      // Muted audio makes no sound at all.
      const before = fake.created();
      audio.setMuted(true);
      audio.play('dash');
      expect(fake.created()).toBe(before);

      // Music schedules notes ahead of the clock.
      audio.setMuted(false);
      audio.setMusic(true, 2);
      const beforeMusic = fake.created();
      audio.update(1 / 60);
      expect(fake.created()).toBeGreaterThan(beforeMusic);

      audio.setMusic(false);
      const beforeIdle = fake.created();
      audio.update(1 / 60);
      expect(fake.created()).toBe(beforeIdle);

      expect(() => audio.resume()).not.toThrow();
      expect(() => audio.dispose()).not.toThrow();
    } finally {
      if (original === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
      } else {
        (globalThis as { AudioContext?: unknown }).AudioContext = original;
      }
    }
  });

  it('rate-limits identical sounds fired in the same instant', () => {
    const fake = fakeAudioContext();
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = fake.Constructor;
    try {
      const audio = new WebAudio();
      audio.play('footstep');
      const after = fake.created();
      // Same sound again within the same frame: suppressed, so twenty walkers cannot clip the mix.
      audio.play('footstep');
      expect(fake.created()).toBe(after);
      // After enough time it plays again.
      audio.update(0.1);
      audio.play('footstep');
      expect(fake.created()).toBeGreaterThan(after);
    } finally {
      if (original === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
      } else {
        (globalThis as { AudioContext?: unknown }).AudioContext = original;
      }
    }
  });
});
