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
  hazard: '#d9564f',
  hazardDark: '#8f3833',

  // Optimus
  shellLight: '#e6ebf2',
  shell: '#c3ccd9',
  shellDark: '#8e99ab',
  joint: '#3a4252',
  visor: '#3fd0ff',
  visorGlow: '#a5ecff',

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
} as const;

export type PaletteKey = keyof typeof palette;
