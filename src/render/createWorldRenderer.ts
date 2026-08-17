import type { World } from '../game/world';
import { tryCreateGlWorldRenderer } from './gl/GlWorldRenderer';
import { ClassicWorldRenderer } from './renderer';
import type { RendererBackendPreference } from './settings';
import type { WorldView } from './view';

export type { RendererBackendPreference } from './settings';

export interface CreateWorldRendererOptions {
  world: World | null;
  preference?: RendererBackendPreference;
  /** Force the Classic Canvas2D backend even when WebGL2 is available. */
  forceClassic?: boolean;
}

/**
 * Picks a {@link WorldView} backend.
 *
 * Prefers WebGL2 when `preference` is `auto`/`webgl2` and {@link tryCreateGlWorldRenderer}
 * succeeds; otherwise falls back to Classic so the game never fails to boot.
 */
export function createWorldRenderer(options: CreateWorldRendererOptions): WorldView {
  const { world, preference = 'auto', forceClassic = false } = options;

  const wantsGl = !forceClassic && shouldTryGl(preference);
  if (wantsGl) {
    const gl = tryCreateGlWorldRenderer(world);
    if (gl !== null) return gl;
  }

  return new ClassicWorldRenderer(world);
}

function shouldTryGl(preference: RendererBackendPreference): boolean {
  switch (preference) {
    case 'auto':
    case 'webgl2':
      return true;
    case 'classic':
      return false;
    default: {
      const exhaustive: never = preference;
      throw new Error(`Unhandled renderer backend preference: ${String(exhaustive)}`);
    }
  }
}
