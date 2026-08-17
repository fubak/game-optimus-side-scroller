/**
 * Colour palette.
 *
 * One place for every colour in the game so levels can be re-tinted and a high-contrast mode can
 * swap the whole scheme later. Kept small and industrial: cold steel, warm rust, cyan tech light.
 */

export const palette = {
  // Backgrounds — deliberately low contrast so the playfield reads first.
  skyTop: '#0d121c',
  skyBottom: '#161d2b',
  farStructure: '#141a27',
  midStructure: '#1a2231',
  nearStructure: '#212b3d',
  fog: '#26314a',

  // Tiles — brighter and warmer than the backdrop, so terrain never blends into the skyline.
  plateFace: '#5d6b86',
  plateLight: '#93a5c4',
  plateDark: '#3b4659',
  plateShadow: '#232a38',
  grate: '#46536a',
  rust: '#9c6440',
  // Slightly hotter hazard for Enhanced emissive accents; still readable flat-fill in Classic.
  hazard: '#e25d55',
  hazardDark: '#943a34',

  // Optimus — shell bevels a touch brighter, visor punchier for Dead Cells bloom without washing
  // Classic's flat-fill contrast (shell still sits clearly above plateFace / joint).
  shellLight: '#eef3f9',
  shell: '#c8d1de',
  shellDark: '#8793a6',
  joint: '#3a4252',
  visor: '#4ad6ff',
  visorGlow: '#b6f0ff',

  // FX & UI
  energy: '#4ce0b3',
  energyDim: '#1f6d59',
  spark: '#ffd989',
  flame: '#ffb14e',
  flameHot: '#fff0c2',
  smoke: '#5a6478',
  white: '#ffffff',
  ink: '#0b0e14',
  uiText: '#dfe5ee',
  uiDim: '#7c879b',
  uiWarn: '#ffca6b',
  health: '#ff6b6b',
};

export type Palette = typeof palette;
export type PaletteKey = keyof Palette;

/**
 * High-contrast overrides.
 *
 * Only the values that matter for readability change: the backdrop drops towards black, terrain and
 * Optimus brighten, and hazards/pickups take saturated colours. Shapes are untouched, so the game
 * looks like itself — just legible on a bad screen or with low vision.
 */
const highContrastOverrides: Partial<Palette> = {
  skyTop: '#000000',
  skyBottom: '#05070c',
  farStructure: '#0a0e16',
  midStructure: '#101620',
  nearStructure: '#182030',
  fog: '#1b2230',
  plateFace: '#7d8ca8',
  plateLight: '#cfdcf2',
  plateDark: '#404b60',
  plateShadow: '#12161f',
  grate: '#5b6a84',
  hazard: '#ff4d4d',
  hazardDark: '#a01f1f',
  shell: '#ffffff',
  shellLight: '#ffffff',
  shellDark: '#b9c4d4',
  visor: '#39e0ff',
  visorGlow: '#ffffff',
  energy: '#3dffc0',
  spark: '#ffe066',
  uiText: '#ffffff',
  uiDim: '#a8b4c6',
  uiWarn: '#ffd23f',
  health: '#ff5c5c',
};

const defaultPalette: Palette = { ...palette };

/**
 * Swap the active palette in place.
 *
 * The palette is imported as a live object everywhere, so mutating it re-tints the entire game
 * (tiles, sprites, HUD, menus, particles) without threading a theme parameter through every draw
 * call. Nothing caches colours between frames, so the change is instant.
 */
export function setHighContrast(enabled: boolean): void {
  Object.assign(palette, defaultPalette, enabled ? highContrastOverrides : {});
}

export function isHighContrast(): boolean {
  return palette.skyTop === highContrastOverrides.skyTop;
}
