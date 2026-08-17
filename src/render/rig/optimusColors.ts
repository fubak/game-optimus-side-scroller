/**
 * Tesla Optimus Gen 2–inspired colours for the Enhanced rig / sprite-sheet path only.
 *
 * Classic Canvas2D (`sprites.ts`) keeps using the shared industrial `palette` so visual
 * regression baselines stay pixel-stable. These values intentionally do not mutate `palette`.
 */

export const OPTIMUS_ENHANCED = {
  /** Pearl polymer body panels. */
  panel: '#f2f3f6',
  panelLight: '#ffffff',
  panelShade: '#cfd3dc',
  /** Charcoal actuator housings / joint covers. */
  joint: '#1a1d24',
  jointSoft: '#2b303a',
  /** Silver structural rings / actuator lips. */
  metal: '#a7adb8',
  metalBright: '#d5d9e0',
  /** Black face OLED / LED matrix. */
  face: '#0a0b0e',
  /** Soft teal status LEDs on the face screen. */
  eye: '#5eead4',
  eyeHot: '#ccfff5',
  /** Subtle chest status pip (not a big sci-fi core well). */
  status: '#4ce0b3',
} as const;
