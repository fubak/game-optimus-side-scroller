/**
 * Global constants and tuning tables.
 *
 * ## The metre is the only unit
 *
 * Every position, size, velocity, and acceleration in gameplay code is
 * expressed in **metres** and **seconds**. Nothing outside the renderer is
 * allowed to think in pixels.
 *
 * This exists to make "consistent scale" an enforceable property rather than an
 * aesthetic hope. Optimus is 1.73 m tall because the real robot is; a door is
 * 2.6 m because a door is; a drone is 0.6 m across. When every asset is authored
 * against the same physical yardstick, the world reads as coherent
 * automatically, and `tools/audit/scale.ts` can mechanically reject anything
 * that drifts.
 */

/** Pixels per metre at the reference resolution. */
export const PIXELS_PER_METRE = 96;

/** The design resolution everything is composed against. */
export const REFERENCE_WIDTH = 1920;
export const REFERENCE_HEIGHT = 1080;

/** Visible world size at reference zoom: 20 m x 11.25 m. */
export const VIEW_WIDTH_METRES = REFERENCE_WIDTH / PIXELS_PER_METRE;
export const VIEW_HEIGHT_METRES = REFERENCE_HEIGHT / PIXELS_PER_METRE;

/**
 * Martian surface gravity is 3.71 m/s². The game runs a little heavier than
 * that: true Mars gravity gives jumps a floaty, unresponsive arc that fights
 * the crisp, servo-driven feel the character is built around. This value keeps
 * the low-gravity *read* — long hang time, drifting dust, slow debris — while
 * still landing with authority.
 */
export const GRAVITY = 24.0;

/** Reference physical dimensions, in metres. Enforced by the scale audit. */
export const SCALE = {
  /** Tesla Optimus Gen 2 stands about 1.73 m. */
  optimusHeight: 1.73,
  /** Collision capsule is narrower than the visual silhouette. */
  optimusBodyWidth: 0.52,
  optimusBodyHeight: 1.66,
  /** Eye height, used to aim the camera at the head rather than the feet. */
  optimusEyeHeight: 1.6,

  tile: 1.0,
  doorHeight: 2.6,
  corridorHeight: 3.5,
  smallEnemy: 0.6,
  mediumEnemy: 1.4,
  largeEnemy: 3.2,
  bossMin: 6.0,
} as const;

/** Rendering layer depths. Higher values are further away. */
export const enum Depth {
  Sky = 10,
  FarParallax = 8,
  MidParallax = 5,
  NearParallax = 3,
  /** The plane the player actually collides with. */
  Playfield = 0,
  Foreground = -2,
  /** Foreground occluders drawn over everything, heavily blurred. */
  Vignette = -4,
}

export const enum Quality {
  Low = 0,
  Medium = 1,
  High = 2,
  Ultra = 3,
}

export interface QualitySettings {
  /** Multiplier on internal render resolution. */
  renderScale: number;
  /** Raymarch steps per shadow-casting light. Dominates lighting cost. */
  shadowSteps: number;
  /** Number of lights permitted to cast shadows at once. */
  shadowCasters: number;
  /** Down/up-sample levels in the bloom chain. */
  bloomLevels: number;
  volumetrics: boolean;
  godRaySamples: number;
  depthOfField: boolean;
  /** Upper bound on simultaneously live particles. */
  particleBudget: number;
  filmGrain: boolean;
  chromaticAberration: boolean;
  /** Ambient environment detail props per screen. */
  ambientDetail: number;
}

export const QUALITY_PRESETS: Record<Quality, QualitySettings> = {
  [Quality.Low]: {
    renderScale: 0.7,
    shadowSteps: 0,
    shadowCasters: 0,
    bloomLevels: 3,
    volumetrics: false,
    godRaySamples: 0,
    depthOfField: false,
    particleBudget: 600,
    filmGrain: false,
    chromaticAberration: false,
    ambientDetail: 0.35,
  },
  [Quality.Medium]: {
    renderScale: 0.85,
    shadowSteps: 8,
    shadowCasters: 2,
    bloomLevels: 4,
    volumetrics: true,
    godRaySamples: 8,
    depthOfField: false,
    particleBudget: 1400,
    filmGrain: true,
    chromaticAberration: true,
    ambientDetail: 0.65,
  },
  [Quality.High]: {
    renderScale: 1.0,
    shadowSteps: 16,
    shadowCasters: 4,
    bloomLevels: 5,
    volumetrics: true,
    godRaySamples: 12,
    depthOfField: true,
    particleBudget: 2600,
    filmGrain: true,
    chromaticAberration: true,
    ambientDetail: 1.0,
  },
  [Quality.Ultra]: {
    renderScale: 1.0,
    shadowSteps: 24,
    shadowCasters: 6,
    bloomLevels: 6,
    volumetrics: true,
    godRaySamples: 16,
    depthOfField: true,
    particleBudget: 4000,
    filmGrain: true,
    chromaticAberration: true,
    ambientDetail: 1.4,
  },
};

/**
 * Hard performance budgets, asserted by `tools/audit/budgets.ts`.
 *
 * These are checked mechanically because performance regressions arrive
 * gradually — one extra fullscreen pass at a time — and are invisible until the
 * frame rate has already collapsed.
 */
export const BUDGETS = {
  maxDrawCalls: 120,
  maxFullscreenPasses: 18,
  maxLiveParticles: 4000,
  maxDynamicLights: 24,
  maxShadowCasters: 6,
  maxTextureMemoryMB: 160,
  /** Per-frame CPU ceilings in milliseconds, at Ultra. */
  maxSimMs: 2.0,
  maxAnimMs: 1.2,
  maxSubmitMs: 1.5,
} as const;

/** The signature player colour. No environment asset may use this hue range. */
export const OPTIMUS_CYAN = { r: 0.247, g: 0.914, b: 1.0 } as const;

export const BUILD = {
  revision: typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev',
  time: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev',
} as const;

declare global {
  const __BUILD_REV__: string;
  const __BUILD_TIME__: string;
}
