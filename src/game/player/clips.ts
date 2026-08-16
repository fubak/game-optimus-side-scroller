/**
 * Optimus animation clips.
 *
 * Authored as keyframe data in degrees, relative to the rest pose. The curve
 * system fills in continuous Hermite interpolation between keys, so a cycle
 * defined by six poses genuinely produces a different pose on every frame at
 * any refresh rate.
 *
 * ## Rotation sign convention
 *
 * A bone's local +X runs along its length, and world +Y is *down*. A limb
 * hanging down therefore rests at +PI/2, and from there:
 *
 * - **negative** rotation swings the limb **forward** (the facing direction)
 * - **positive** rotation swings it **backward**
 *
 * Knees and elbows bend backward, so their flexion values are positive.
 *
 * ## Authoring notes
 *
 * Cycles use six keys rather than four. Four keys (contact, pass, contact,
 * pass) produce a mechanically even gait; the two extra keys at the swing
 * extremes are where the character's weight and personality actually live.
 */

import type { ClipDefinition } from '../../anim/clip.ts';

/**
 * Idle.
 *
 * Almost still, but never actually still. A completely static idle instantly
 * reads as a paused game. The motion here is deliberately mechanical — a slow
 * servo-driven settle rather than organic breathing — with a long 4.4 s cycle
 * so it never feels like a loop.
 */
export const IDLE: ClipDefinition = {
  name: 'idle',
  duration: 4.4,
  loop: true,
  bones: {
    hips: {
      y: [
        [0, 0],
        [1.1, 0.006],
        [2.2, 0],
        [3.3, 0.005],
        [4.4, 0],
      ],
      rot: [
        [0, 0],
        [2.2, 0.7],
        [4.4, 0],
      ],
    },
    abdomen: {
      rot: [
        [0, 0],
        [1.5, -0.8],
        [3.0, 0.5],
        [4.4, 0],
      ],
    },
    chest: {
      rot: [
        [0, 0],
        [1.1, 1.2],
        [2.6, -0.6],
        [4.4, 0],
      ],
      // A very small vertical scale change reads as the chassis settling on its
      // suspension, without the organic look of a breathing ribcage.
      scaleY: [
        [0, 1],
        [1.1, 1.006],
        [2.2, 1],
        [3.3, 1.004],
        [4.4, 1],
      ],
    },
    head: {
      rot: [
        [0, 0],
        [1.8, -1.4],
        [3.4, 0.9],
        [4.4, 0],
      ],
    },
    upperArmNear: {
      rot: [
        [0, 3],
        [2.2, 5],
        [4.4, 3],
      ],
    },
    forearmNear: {
      rot: [
        [0, 12],
        [2.2, 15],
        [4.4, 12],
      ],
    },
    upperArmFar: {
      rot: [
        [0, 4],
        [2.0, 6.5],
        [4.4, 4],
      ],
    },
    forearmFar: {
      rot: [
        [0, 14],
        [2.0, 17],
        [4.4, 14],
      ],
    },
    thighNear: { rot: [[0, -1.5]] },
    shinNear: { rot: [[0, 3]] },
    thighFar: { rot: [[0, 2]] },
    shinFar: { rot: [[0, 4]] },
  },
};

/**
 * Walk.
 *
 * A grounded, deliberate gait. Optimus is a heavy machine, so the cycle is slow
 * (1.05 s) with a pronounced heel-first contact and very little vertical bounce
 * — bounce reads as lightness, which is exactly wrong for this character.
 */
export const WALK: ClipDefinition = {
  name: 'walk',
  duration: 1.05,
  loop: true,
  clamped: true,
  bones: {
    // --- Near leg: contact at t=0 -----------------------------------------
    thighNear: {
      rot: [
        [0, -24],
        [0.18, -14],
        [0.35, 2],
        [0.52, 18],
        [0.72, 6],
        [0.88, -18],
        [1.05, -24],
      ],
    },
    shinNear: {
      rot: [
        [0, 6],
        [0.18, 10],
        [0.35, 6],
        [0.52, 10],
        [0.72, 52],
        [0.88, 26],
        [1.05, 6],
      ],
    },
    footNear: {
      rot: [
        [0, -10],
        [0.18, 2],
        [0.35, 4],
        [0.52, -14],
        [0.72, -20],
        [0.88, -14],
        [1.05, -10],
      ],
    },

    // --- Far leg: half a cycle out of phase --------------------------------
    thighFar: {
      rot: [
        [0, 18],
        [0.2, 6],
        [0.36, -18],
        [0.525, -24],
        [0.7, -14],
        [0.86, 2],
        [1.05, 18],
      ],
    },
    shinFar: {
      rot: [
        [0, 10],
        [0.2, 52],
        [0.36, 26],
        [0.525, 6],
        [0.7, 10],
        [0.86, 6],
        [1.05, 10],
      ],
    },
    footFar: {
      rot: [
        [0, -14],
        [0.2, -20],
        [0.36, -14],
        [0.525, -10],
        [0.7, 2],
        [0.86, 4],
        [1.05, -14],
      ],
    },

    // --- Pelvis: two bobs per cycle, one per step -------------------------
    hips: {
      y: [
        [0, 0],
        [0.26, -0.022],
        [0.525, 0],
        [0.79, -0.022],
        [1.05, 0],
      ],
      rot: [
        [0, 2.2],
        [0.525, -2.2],
        [1.05, 2.2],
      ],
    },

    // Counter-rotation through the spine, so the shoulders stay level while
    // the hips swing. Without it the whole torso rolls and looks drunk.
    abdomen: {
      rot: [
        [0, -1.6],
        [0.525, 1.6],
        [1.05, -1.6],
      ],
    },
    chest: {
      rot: [
        [0, -2.6],
        [0.525, 2.6],
        [1.05, -2.6],
      ],
    },
    head: {
      rot: [
        [0, 1.4],
        [0.525, -1.4],
        [1.05, 1.4],
      ],
    },

    // --- Arms swing opposite the legs -------------------------------------
    upperArmNear: {
      rot: [
        [0, 20],
        [0.26, 8],
        [0.525, -17],
        [0.79, 4],
        [1.05, 20],
      ],
    },
    forearmNear: {
      rot: [
        [0, 14],
        [0.26, 22],
        [0.525, 30],
        [0.79, 20],
        [1.05, 14],
      ],
    },
    upperArmFar: {
      rot: [
        [0, -17],
        [0.26, 4],
        [0.525, 20],
        [0.79, 8],
        [1.05, -17],
      ],
    },
    forearmFar: {
      rot: [
        [0, 30],
        [0.26, 20],
        [0.525, 14],
        [0.79, 22],
        [1.05, 30],
      ],
    },
  },
};

/**
 * Run.
 *
 * Not simply a faster walk: the whole posture changes. The torso pitches
 * forward, stride length roughly doubles, the arms drive hard with tightly bent
 * elbows, and there is a genuine airborne phase where the pelvis lifts.
 */
export const RUN: ClipDefinition = {
  name: 'run',
  duration: 0.62,
  loop: true,
  clamped: true,
  bones: {
    thighNear: {
      rot: [
        [0, -42],
        [0.1, -22],
        [0.21, 8],
        [0.31, 32],
        [0.42, 14],
        [0.52, -34],
        [0.62, -42],
      ],
    },
    shinNear: {
      rot: [
        [0, 14],
        [0.1, 8],
        [0.21, 18],
        [0.31, 34],
        [0.42, 88],
        [0.52, 46],
        [0.62, 14],
      ],
    },
    footNear: {
      rot: [
        [0, -18],
        [0.1, 6],
        [0.21, 10],
        [0.31, -22],
        [0.42, -34],
        [0.52, -26],
        [0.62, -18],
      ],
    },

    thighFar: {
      rot: [
        [0, 32],
        [0.11, 14],
        [0.21, -34],
        [0.31, -42],
        [0.42, -22],
        [0.52, 8],
        [0.62, 32],
      ],
    },
    shinFar: {
      rot: [
        [0, 34],
        [0.11, 88],
        [0.21, 46],
        [0.31, 14],
        [0.42, 8],
        [0.52, 18],
        [0.62, 34],
      ],
    },
    footFar: {
      rot: [
        [0, -22],
        [0.11, -34],
        [0.21, -26],
        [0.31, -18],
        [0.42, 6],
        [0.52, 10],
        [0.62, -22],
      ],
    },

    hips: {
      y: [
        [0, -0.01],
        [0.155, -0.055],
        [0.31, -0.01],
        [0.465, -0.055],
        [0.62, -0.01],
      ],
      rot: [
        [0, 4],
        [0.31, -4],
        [0.62, 4],
      ],
    },

    // The forward pitch that distinguishes a run from a fast walk.
    abdomen: {
      rot: [
        [0, -5],
        [0.31, -8],
        [0.62, -5],
      ],
    },
    chest: {
      rot: [
        [0, -9],
        [0.155, -6],
        [0.31, -11],
        [0.465, -6],
        [0.62, -9],
      ],
    },
    // The head counter-pitches to stay level, which is what keeps the optic
    // strip readable while running.
    head: {
      rot: [
        [0, 9],
        [0.31, 11],
        [0.62, 9],
      ],
    },

    upperArmNear: {
      rot: [
        [0, 44],
        [0.155, 12],
        [0.31, -38],
        [0.465, 6],
        [0.62, 44],
      ],
    },
    forearmNear: {
      rot: [
        [0, 62],
        [0.155, 78],
        [0.31, 86],
        [0.465, 70],
        [0.62, 62],
      ],
    },
    upperArmFar: {
      rot: [
        [0, -38],
        [0.155, 6],
        [0.31, 44],
        [0.465, 12],
        [0.62, -38],
      ],
    },
    forearmFar: {
      rot: [
        [0, 86],
        [0.155, 70],
        [0.31, 62],
        [0.465, 78],
        [0.62, 86],
      ],
    },
  },
};

/**
 * Jump launch.
 *
 * A one-shot that fires on takeoff. The pose extends hard — legs driving down,
 * arms thrown up — which is the anticipation-and-release shape that makes a
 * jump feel powered rather than merely upward.
 */
export const JUMP_RISE: ClipDefinition = {
  name: 'jumpRise',
  duration: 0.42,
  loop: false,
  clamped: true,
  bones: {
    thighNear: {
      rot: [
        [0, 26],
        [0.12, -18],
        [0.42, -26],
      ],
    },
    shinNear: {
      rot: [
        [0, 46],
        [0.12, 30],
        [0.42, 22],
      ],
    },
    footNear: {
      rot: [
        [0, -28],
        [0.12, -12],
        [0.42, -8],
      ],
    },
    thighFar: {
      rot: [
        [0, 20],
        [0.14, 12],
        [0.42, 16],
      ],
    },
    shinFar: {
      rot: [
        [0, 40],
        [0.14, 52],
        [0.42, 58],
      ],
    },
    footFar: {
      rot: [
        [0, -24],
        [0.14, -18],
        [0.42, -14],
      ],
    },
    hips: {
      y: [
        [0, 0.03],
        [0.12, -0.02],
        [0.42, -0.01],
      ],
    },
    abdomen: {
      rot: [
        [0, 4],
        [0.12, -6],
        [0.42, -4],
      ],
    },
    chest: {
      rot: [
        [0, 7],
        [0.12, -8],
        [0.42, -5],
      ],
    },
    upperArmNear: {
      rot: [
        [0, 30],
        [0.14, -52],
        [0.42, -40],
      ],
    },
    forearmNear: {
      rot: [
        [0, 40],
        [0.14, 18],
        [0.42, 26],
      ],
    },
    upperArmFar: {
      rot: [
        [0, 26],
        [0.14, -44],
        [0.42, -34],
      ],
    },
    forearmFar: {
      rot: [
        [0, 44],
        [0.14, 24],
        [0.42, 30],
      ],
    },
  },
};

/**
 * Falling.
 *
 * Loops while airborne and descending. Legs gather under the body ready to
 * absorb the landing, and the arms come out for balance.
 */
export const FALL: ClipDefinition = {
  name: 'fall',
  duration: 1.6,
  loop: true,
  clamped: true,
  bones: {
    thighNear: {
      rot: [
        [0, -14],
        [0.8, -20],
        [1.6, -14],
      ],
    },
    shinNear: {
      rot: [
        [0, 34],
        [0.8, 42],
        [1.6, 34],
      ],
    },
    footNear: {
      rot: [
        [0, -16],
        [0.8, -22],
        [1.6, -16],
      ],
    },
    thighFar: {
      rot: [
        [0, 10],
        [0.8, 16],
        [1.6, 10],
      ],
    },
    shinFar: {
      rot: [
        [0, 46],
        [0.8, 54],
        [1.6, 46],
      ],
    },
    footFar: {
      rot: [
        [0, -20],
        [0.8, -26],
        [1.6, -20],
      ],
    },
    abdomen: { rot: [[0, 3]] },
    chest: {
      rot: [
        [0, 5],
        [0.8, 7],
        [1.6, 5],
      ],
    },
    head: { rot: [[0, -6]] },
    upperArmNear: {
      rot: [
        [0, -28],
        [0.8, -34],
        [1.6, -28],
      ],
    },
    forearmNear: {
      rot: [
        [0, 44],
        [0.8, 52],
        [1.6, 44],
      ],
    },
    upperArmFar: {
      rot: [
        [0, -34],
        [0.8, -28],
        [1.6, -34],
      ],
    },
    forearmFar: {
      rot: [
        [0, 50],
        [0.8, 44],
        [1.6, 50],
      ],
    },
  },
};

/**
 * Landing.
 *
 * A deep compression that recovers over roughly a third of a second. The
 * inertializer means this can be entered from any airborne pose without a pop,
 * and the impact spring layered on top scales the depth with real impact
 * velocity — so a short hop and a long drop land visibly differently from the
 * same clip.
 */
export const LAND: ClipDefinition = {
  name: 'land',
  duration: 0.38,
  loop: false,
  clamped: true,
  bones: {
    thighNear: {
      rot: [
        [0, -20],
        [0.09, 16],
        [0.38, -2],
      ],
    },
    shinNear: {
      rot: [
        [0, 30],
        [0.09, 58],
        [0.38, 8],
      ],
    },
    footNear: {
      rot: [
        [0, -18],
        [0.09, -30],
        [0.38, -4],
      ],
    },
    thighFar: {
      rot: [
        [0, 12],
        [0.09, 22],
        [0.38, 3],
      ],
    },
    shinFar: {
      rot: [
        [0, 44],
        [0.09, 62],
        [0.38, 10],
      ],
    },
    footFar: {
      rot: [
        [0, -22],
        [0.09, -32],
        [0.38, -6],
      ],
    },
    hips: {
      y: [
        [0, -0.02],
        [0.09, 0.085],
        [0.24, -0.01],
        [0.38, 0],
      ],
    },
    abdomen: {
      rot: [
        [0, 4],
        [0.09, 9],
        [0.38, 1],
      ],
    },
    chest: {
      rot: [
        [0, 6],
        [0.09, 13],
        [0.38, 1],
      ],
    },
    head: {
      rot: [
        [0, -5],
        [0.09, -11],
        [0.38, -1],
      ],
    },
    upperArmNear: {
      rot: [
        [0, -30],
        [0.09, 22],
        [0.38, 4],
      ],
    },
    forearmNear: {
      rot: [
        [0, 46],
        [0.09, 34],
        [0.38, 14],
      ],
    },
    upperArmFar: {
      rot: [
        [0, -26],
        [0.09, 18],
        [0.38, 5],
      ],
    },
    forearmFar: {
      rot: [
        [0, 50],
        [0.09, 38],
        [0.38, 16],
      ],
    },
  },
};

export const OPTIMUS_CLIPS = { IDLE, WALK, RUN, JUMP_RISE, FALL, LAND } as const;
