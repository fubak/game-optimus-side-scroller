/**
 * Colour palette.
 *
 * One place for every colour in the game so levels can be re-tinted and a high-contrast mode can
 * swap the whole scheme later. Kept small and industrial: cold steel, warm rust, cyan tech light.
 */

export const palette = {
  // Backgrounds
  skyTop: '#141a26',
  skyBottom: '#232c3d',
  farStructure: '#1b2231',
  midStructure: '#232c3e',
  nearStructure: '#2c374c',
  fog: '#39465e',

  // Tiles
  plateFace: '#4c586e',
  plateLight: '#697894',
  plateDark: '#333c4e',
  plateShadow: '#252c3a',
  grate: '#3b4557',
  rust: '#8a5a3b',
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
