/**
 * Renderer quality / backend preferences.
 *
 * Kept separate from the gameplay save blob (`src/core/storage.ts`) so visual settings can evolve
 * without touching the untouchable simulation save format. Missing or corrupt values fall back to
 * safe defaults — the game must always boot.
 */

export type RendererBackendPreference = 'auto' | 'classic' | 'webgl2';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface RenderSettings {
  /** Backend selection. `auto` prefers WebGL2 and falls back to Classic. */
  backend: RendererBackendPreference;
  /** Overall quality preset; drives which post/lighting features are enabled. */
  quality: QualityPreset;
  /** Backbuffer scale relative to CSS size × devicePixelRatio. 0.5–2.0. */
  renderScale: number;
  /** Hold ~60 fps by shrinking the backbuffer when frame time spikes. */
  dynamicResolution: boolean;
  bloom: boolean;
  vignette: boolean;
  grain: boolean;
  chromaticAberration: boolean;
  motionBlur: boolean;
  shadows: boolean;
  particles: boolean;
}

export const RENDER_SETTINGS_KEY = 'optimus.render.v1';

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  backend: 'auto',
  quality: 'high',
  renderScale: 1,
  dynamicResolution: true,
  bloom: true,
  vignette: true,
  grain: true,
  chromaticAberration: true,
  motionBlur: true,
  shadows: true,
  particles: true,
};

/** Per-preset feature toggles. Individual flags in {@link RenderSettings} still win when set. */
export const QUALITY_PRESETS: Record<
  QualityPreset,
  Pick<
    RenderSettings,
    | 'renderScale'
    | 'dynamicResolution'
    | 'bloom'
    | 'vignette'
    | 'grain'
    | 'chromaticAberration'
    | 'motionBlur'
    | 'shadows'
    | 'particles'
  >
> = {
  low: {
    renderScale: 0.75,
    dynamicResolution: true,
    bloom: false,
    vignette: true,
    grain: false,
    chromaticAberration: false,
    motionBlur: false,
    shadows: false,
    particles: true,
  },
  medium: {
    renderScale: 1,
    dynamicResolution: true,
    bloom: true,
    vignette: true,
    grain: false,
    chromaticAberration: false,
    motionBlur: false,
    shadows: true,
    particles: true,
  },
  high: {
    renderScale: 1,
    dynamicResolution: true,
    bloom: true,
    vignette: true,
    grain: true,
    chromaticAberration: true,
    motionBlur: true,
    shadows: true,
    particles: true,
  },
  ultra: {
    renderScale: 1.5,
    dynamicResolution: false,
    bloom: true,
    vignette: true,
    grain: true,
    chromaticAberration: true,
    motionBlur: true,
    shadows: true,
    particles: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackend(value: unknown): RendererBackendPreference {
  switch (value) {
    case 'auto':
    case 'classic':
    case 'webgl2':
      return value;
    default:
      return DEFAULT_RENDER_SETTINGS.backend;
  }
}

function parseQuality(value: unknown): QualityPreset {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'ultra':
      return value;
    default:
      return DEFAULT_RENDER_SETTINGS.quality;
  }
}

function parseBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RENDER_SETTINGS.renderScale;
  return Math.min(2, Math.max(0.5, value));
}

export function parseRenderSettings(value: unknown): RenderSettings {
  if (!isRecord(value)) return { ...DEFAULT_RENDER_SETTINGS };
  const quality = parseQuality(value.quality);
  const preset = QUALITY_PRESETS[quality];
  return {
    backend: parseBackend(value.backend),
    quality,
    renderScale: parseScale(value.renderScale ?? preset.renderScale),
    dynamicResolution: parseBool(value.dynamicResolution, preset.dynamicResolution),
    bloom: parseBool(value.bloom, preset.bloom),
    vignette: parseBool(value.vignette, preset.vignette),
    grain: parseBool(value.grain, preset.grain),
    chromaticAberration: parseBool(value.chromaticAberration, preset.chromaticAberration),
    motionBlur: parseBool(value.motionBlur, preset.motionBlur),
    shadows: parseBool(value.shadows, preset.shadows),
    particles: parseBool(value.particles, preset.particles),
  };
}

/** Apply a quality preset, preserving the backend choice. */
export function applyQualityPreset(settings: RenderSettings, quality: QualityPreset): RenderSettings {
  return {
    ...settings,
    quality,
    ...QUALITY_PRESETS[quality],
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadRenderSettings(storage: StorageLike): RenderSettings {
  try {
    const raw = storage.getItem(RENDER_SETTINGS_KEY);
    if (raw === null || raw === '') return { ...DEFAULT_RENDER_SETTINGS };
    return parseRenderSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_RENDER_SETTINGS };
  }
}

export function saveRenderSettings(storage: StorageLike, settings: RenderSettings): void {
  try {
    storage.setItem(RENDER_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/blocked — keep running with in-memory settings.
  }
}

/**
 * Reduced-motion accessibility: force motion-sensitive post effects off.
 * Does not mutate the stored preferences — callers pass the result into the renderer.
 */
export function withReducedMotion(settings: RenderSettings): RenderSettings {
  return {
    ...settings,
    bloom: false,
    grain: false,
    chromaticAberration: false,
    motionBlur: false,
  };
}

/** Resolve backend preference from URL params, then saved settings. */
export function resolveBackendPreference(
  search: string,
  settings: RenderSettings,
): RendererBackendPreference {
  const params = new URLSearchParams(search);
  const classic = params.get('classic');
  if (classic === '1' || classic === 'true') return 'classic';
  const renderer = params.get('renderer');
  switch (renderer) {
    case 'classic':
    case 'webgl2':
    case 'auto':
      return renderer;
    case null:
    case '':
      return settings.backend;
    default:
      return settings.backend;
  }
}
