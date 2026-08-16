/**
 * Optimus part art.
 *
 * Every piece of the character is generated here from the same small vocabulary
 * of forms, which is what holds the "unified mechanical design language"
 * together: rounded shell plates in matte off-white, a dark graphite
 * understructure showing at every joint, exposed actuator cylinders at the
 * knees and elbows, and a single cyan optic strip on an otherwise featureless
 * visor.
 *
 * ## Proportions
 *
 * Tesla's Optimus stands about 1.73 m. Every measurement below is derived from
 * that figure and expressed in metres, so the character is in genuine
 * proportion to doors, crates, and enemies rather than approximately so.
 *
 * ```
 *   head                    0.24
 *   neck -> hip             0.50
 *   hip -> knee             0.44
 *   knee -> ankle           0.42
 *   ankle -> ground         0.09
 *   shoulder -> elbow       0.31
 *   elbow -> wrist          0.27
 * ```
 *
 * ## Far-side limbs
 *
 * In a side view both arms and both legs are visible. The far-side copies are
 * generated darker and slightly desaturated rather than being the same sprite
 * tinted at draw time, because baking the shift lets the far limb also carry
 * reduced relief — which is what stops it competing with the near limb for
 * attention.
 */

import { NoiseField } from '../core/math/noise.ts';
import {
  createSurface,
  addEdgeWear,
  type Surface,
} from './texgen.ts';
import {
  fillSdf,
  cutSeam,
  paintEmissive,
  sdCapsule,
  sdTaperedCapsule,
  sdRoundedBox,
  sdRotatedBox,
  sdCircle,
  smoothUnion,
  union,
  type ShapeStyle,
} from './sdf.ts';
import { PALETTE } from './library.ts';
import type { AtlasSource } from './atlas.ts';
import { PIXELS_PER_METRE } from '../core/config.ts';

/**
 * Parts are generated at four times their on-screen size.
 *
 * Optimus occupies roughly 170 px of a 1080p frame, so his forearm is about
 * 26 px. Generating at 1:1 would leave no room for the bevels and seams the
 * design language depends on; supersampling means the detail survives, and the
 * mipmapped atlas resolves it cleanly at any zoom.
 */
export const OPTIMUS_SUPERSAMPLE = 4;

const px = (metres: number): number =>
  Math.max(4, Math.round(metres * PIXELS_PER_METRE * OPTIMUS_SUPERSAMPLE));

/**
 * Skeleton dimensions in metres. Shared by the art and the rig definition.
 *
 * These are solved as a chain rather than chosen independently, so the parts
 * actually stack to 1.73 m with no gaps:
 *
 * ```
 *   ground        0.00
 *   ankle        -0.09     foot height
 *   knee         -0.48     shin  0.39
 *   hip joint    -0.90     thigh 0.42
 *   pelvis top   -1.00
 *   chest base   -1.17     abdomen 0.17
 *   shoulder     -1.38
 *   neck base    -1.43     chest 0.26
 *   head base    -1.49     neck  0.06
 *   crown        -1.73     head  0.24
 * ```
 *
 * The build is deliberately heavier than a human of the same height: broader
 * shoulders, thicker limbs, a deeper chest. A correctly-proportioned human
 * skeleton at this scale reads as spindly and fragile, which is the opposite of
 * the machine presence the character needs.
 */
export const OPTIMUS_DIMENSIONS = {
  totalHeight: 1.73,

  headHeight: 0.24,
  headWidth: 0.20,
  neckLength: 0.06,
  neckWidth: 0.11,

  chestHeight: 0.26,
  chestWidth: 0.42,
  abdomenHeight: 0.17,
  abdomenWidth: 0.28,
  pelvisHeight: 0.16,
  pelvisWidth: 0.34,

  upperArmLength: 0.28,
  upperArmWidth: 0.135,
  forearmLength: 0.25,
  forearmWidth: 0.115,
  handLength: 0.15,
  handWidth: 0.095,

  thighLength: 0.42,
  thighWidth: 0.185,
  shinLength: 0.39,
  shinWidth: 0.155,
  footLength: 0.25,
  footHeight: 0.09,

  backpackWidth: 0.20,
  backpackHeight: 0.28,
} as const;

const wearNoise = new NoiseField(0x0b71);

/** Shared material style for the white shell plates. */
const shellStyle = (dark = false): ShapeStyle => ({
  color: dark
    ? [PALETTE.shellMid[0] * 0.46, PALETTE.shellMid[1] * 0.47, PALETTE.shellMid[2] * 0.52]
    : PALETTE.shellLight,
  rimColor: dark
    ? [PALETTE.shellMid[0] * 0.62, PALETTE.shellMid[1] * 0.63, PALETTE.shellMid[2] * 0.70]
    : [1.0, 1.0, 1.0],
  bevel: 4.5 * (OPTIMUS_SUPERSAMPLE / 4),
  height: dark ? 0.62 : 1,
  roughness: 0.36,
  metallic: 0.35,
  dome: 0.55,
});

/** Dark graphite understructure, visible at every joint. */
const frameStyle = (dark = false): ShapeStyle => ({
  color: dark
    ? [PALETTE.frame[0] * 0.6, PALETTE.frame[1] * 0.6, PALETTE.frame[2] * 0.6]
    : PALETTE.frame,
  rimColor: dark
    ? [PALETTE.shellDark[0] * 0.5, PALETTE.shellDark[1] * 0.5, PALETTE.shellDark[2] * 0.55]
    : PALETTE.shellDark,
  bevel: 3 * (OPTIMUS_SUPERSAMPLE / 4),
  height: dark ? 0.4 : 0.7,
  roughness: 0.5,
  metallic: 0.9,
});

/**
 * A limb segment: dark joint sleeve, shell plate over it, actuator detail.
 *
 * Oriented with the joint at the top of the image and the tip at the bottom,
 * matching the bone convention where a bone points from its origin toward its
 * child.
 */
function makeLimbSegment(
  lengthMetres: number,
  widthMetres: number,
  options: {
    dark?: boolean;
    taper?: number;
    actuator?: boolean;
    accent?: boolean;
    seed?: number;
  } = {},
): Surface {
  const dark = options.dark ?? false;
  const taper = options.taper ?? 0.82;

  // Pad so bevels and the joint sleeve are not clipped at the image edge.
  const pad = px(0.035);
  const width = px(widthMetres) + pad * 2;
  const height = px(lengthMetres) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const topY = pad;
  const bottomY = height - pad;
  const radius = px(widthMetres) / 2;

  // Joint sleeve: a dark cylinder at the proximal end, always slightly wider
  // than the shell so it reads as the thing the shell is mounted on.
  fillSdf(
    surface,
    sdCircle(cx, topY + radius * 0.15, radius * 1.02),
    frameStyle(dark),
  );

  // The shell plate.
  fillSdf(
    surface,
    sdTaperedCapsule(cx, topY + radius * 0.55, cx, bottomY - radius * 0.6, radius * 0.94, radius * 0.94 * taper),
    shellStyle(dark),
  );

  // Actuator cylinder running down the side — the detail that most says
  // "servo-driven machine" rather than "armoured figure".
  if (options.actuator) {
    const side = cx + radius * 0.62;
    fillSdf(
      surface,
      sdCapsule(side, topY + radius * 1.1, side, bottomY - radius * 1.0, radius * 0.20),
      {
        ...frameStyle(dark),
        color: dark ? [0.16, 0.165, 0.18] : [0.30, 0.31, 0.34],
        rimColor: dark ? [0.30, 0.31, 0.34] : [0.62, 0.64, 0.68],
        metallic: 1,
        roughness: 0.22,
        height: 0.85,
      },
    );
  }

  // Panel seam across the shell.
  cutSeam(
    surface,
    sdRoundedBox(cx, topY + (bottomY - topY) * 0.42, width, px(0.006), 0),
    Math.max(1.5, px(0.008)),
    0.35,
    dark ? [0.05, 0.05, 0.06] : PALETTE.joint,
  );

  // Cyan accent along the joint sleeve.
  if (options.accent) {
    paintEmissive(
      surface,
      sdCircle(cx, topY + radius * 0.15, radius * 0.72),
      Math.max(1.5, px(0.009)),
      PALETTE.cyan,
      dark ? 0.45 : 1,
    );
  }

  addEdgeWear(surface, wearNoise, dark ? 0.18 : 0.30, 0.06);
  return surface;
}

/**
 * The head.
 *
 * Deliberately featureless apart from the optic strip. A blank visor with one
 * glowing line is both the real Optimus's design and a strong readability
 * choice: at 170 px tall the head is barely 24 px, and a single high-contrast
 * horizontal accent is legible at that size where eyes or a face would be mush.
 */
function makeHead(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.03);
  const width = px(dimensions.headWidth) + pad * 2;
  const height = px(dimensions.headHeight) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const halfW = px(dimensions.headWidth) / 2;
  const halfH = px(dimensions.headHeight) / 2;

  // Dark helmet shell behind.
  fillSdf(surface, sdRoundedBox(cx, cy, halfW, halfH, halfW * 0.55), {
    ...frameStyle(),
    color: [0.10, 0.105, 0.12],
    rimColor: [0.28, 0.29, 0.33],
    height: 0.7,
  });

  // White face plate, inset, with a subtle chin bevel from the rotated box.
  fillSdf(
    surface,
    sdRotatedBox(cx + halfW * 0.10, cy, halfW * 0.72, halfH * 0.80, halfW * 0.42, -0.05),
    {
      ...shellStyle(),
      bevel: 5 * (OPTIMUS_SUPERSAMPLE / 4),
      dome: 0.7,
    },
  );

  // The optic strip: pushed well above 1 so it crosses the bloom threshold and
  // reads as genuinely luminous rather than merely light-coloured.
  paintEmissive(
    surface,
    sdRoundedBox(cx + halfW * 0.18, cy - halfH * 0.12, halfW * 0.60, px(0.008), px(0.004)),
    Math.max(2, px(0.012)),
    PALETTE.cyan,
    1,
  );

  addEdgeWear(surface, wearNoise, 0.22, 0.08);
  return surface;
}

/** The chest: the largest shell plate, and the character's visual anchor. */
function makeChest(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.04);
  const width = px(dimensions.chestWidth) + pad * 2;
  const height = px(dimensions.chestHeight) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const halfW = px(dimensions.chestWidth) / 2;
  const halfH = px(dimensions.chestHeight) / 2;

  // Understructure, visible as a dark rim around the shell.
  fillSdf(surface, sdRoundedBox(cx, cy, halfW * 0.97, halfH * 0.99, halfW * 0.30), frameStyle());

  // Broad collar across the top, which is what creates the shoulder line.
  fillSdf(
    surface,
    sdRoundedBox(cx, cy - halfH * 0.62, halfW * 0.95, halfH * 0.30, halfH * 0.26),
    { ...shellStyle(), color: [0.50, 0.51, 0.55], rimColor: [0.80, 0.81, 0.85], dome: 0.5 },
  );

  // Main breastplate: one symmetric form, tapering toward the waist.
  fillSdf(
    surface,
    sdTaperedCapsule(
      cx,
      cy - halfH * 0.26,
      cx,
      cy + halfH * 0.66,
      halfW * 0.80,
      halfW * 0.58,
    ),
    { ...shellStyle(), dome: 0.8 },
  );

  // Central sternum channel with a cyan power line down its length.
  cutSeam(
    surface,
    sdRoundedBox(cx, cy + halfH * 0.10, px(0.011), halfH * 0.62, px(0.005)),
    Math.max(2, px(0.013)),
    0.42,
    PALETTE.joint,
  );
  paintEmissive(
    surface,
    sdRoundedBox(cx, cy + halfH * 0.12, px(0.004), halfH * 0.46, px(0.002)),
    Math.max(1.5, px(0.008)),
    PALETTE.cyan,
    0.9,
  );

  // Pectoral panel seams, the detail that makes the plate read as assembled.
  for (const side of [-1, 1]) {
    cutSeam(
      surface,
      sdRotatedBox(cx + side * halfW * 0.42, cy + halfH * 0.05, px(0.006), halfH * 0.34, 0, side * 0.18),
      Math.max(1.2, px(0.006)),
      0.3,
      PALETTE.joint,
    );
  }

  addEdgeWear(surface, wearNoise, 0.34, 0.05);
  return surface;
}

function makeAbdomen(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.03);
  const width = px(dimensions.abdomenWidth) + pad * 2;
  const height = px(dimensions.abdomenHeight) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const halfW = px(dimensions.abdomenWidth) / 2;
  const halfH = px(dimensions.abdomenHeight) / 2;

  // Exposed segmented spine: dark, flexible-looking, deliberately *not* shelled
  // so the character reads as having an articulated waist.
  fillSdf(surface, sdRoundedBox(cx, cy, halfW * 0.85, halfH, halfW * 0.45), frameStyle());

  const segments = 3;
  for (let i = 0; i < segments; i++) {
    const t = (i + 0.5) / segments;
    fillSdf(
      surface,
      sdRoundedBox(cx, cy + (t - 0.5) * halfH * 1.7, halfW * 0.72, halfH * 0.22, halfW * 0.3),
      {
        ...shellStyle(),
        color: [0.52, 0.53, 0.57],
        rimColor: [0.78, 0.79, 0.83],
        height: 0.6,
      },
    );
  }

  addEdgeWear(surface, wearNoise, 0.25, 0.07);
  return surface;
}

function makePelvis(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.03);
  const width = px(dimensions.pelvisWidth) + pad * 2;
  const height = px(dimensions.pelvisHeight) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const halfW = px(dimensions.pelvisWidth) / 2;
  const halfH = px(dimensions.pelvisHeight) / 2;

  fillSdf(surface, sdRoundedBox(cx, cy, halfW * 0.94, halfH * 0.95, halfW * 0.42), frameStyle());
  fillSdf(
    surface,
    sdRoundedBox(cx, cy - halfH * 0.15, halfW * 0.80, halfH * 0.58, halfW * 0.38),
    shellStyle(),
  );

  // Hip actuator housings.
  for (const side of [-1, 1]) {
    fillSdf(surface, sdCircle(cx + side * halfW * 0.66, cy + halfH * 0.32, halfW * 0.26), {
      ...frameStyle(),
      metallic: 1,
      roughness: 0.25,
    });
  }

  addEdgeWear(surface, wearNoise, 0.3, 0.06);
  return surface;
}

/**
 * The foot.
 *
 * Given a defined heel and toe so the IK's slope alignment has something to
 * read against. A featureless block would make ground contact ambiguous, which
 * is exactly what foot IK exists to resolve.
 */
function makeFoot(dark = false): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.02);
  const width = px(dimensions.footLength) + pad * 2;
  const height = px(dimensions.footHeight * 2.0) + pad * 2;
  const surface = createSurface(width, height);

  // The sole rests on the bottom edge of the image so the attachment can align
  // it with the ground without a magic offset.
  const soleY = height - pad - px(0.022);
  const heelX = pad + px(0.042);
  const toeX = width - pad - px(0.028);

  // Ankle housing, sitting above the heel where the shin arrives.
  fillSdf(
    surface,
    sdCircle(heelX + px(0.052), soleY - px(0.072), px(0.048)),
    frameStyle(dark),
  );

  // Boot shell: a wedge that is deeper at the heel than at the toe.
  fillSdf(
    surface,
    smoothUnion(
      px(0.02),
      sdRoundedBox(heelX + px(0.055), soleY - px(0.042), px(0.058), px(0.040), px(0.020)),
      sdTaperedCapsule(heelX + px(0.02), soleY, toeX, soleY, px(0.026), px(0.019)),
    ),
    { ...shellStyle(dark), dome: 0.35 },
  );

  // Toe cap in the darker frame material, so the foot has a defined front.
  fillSdf(
    surface,
    sdTaperedCapsule(toeX - px(0.055), soleY + px(0.002), toeX, soleY + px(0.002), px(0.022), px(0.017)),
    { ...frameStyle(dark), height: 0.55 },
  );

  // Grip tread: shallow horizontal notches along the sole, not vertical bars.
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    const x = heelX + (toeX - heelX) * t;
    cutSeam(
      surface,
      sdRoundedBox(x, soleY + px(0.016), px(0.003), px(0.008), 0),
      Math.max(1.0, px(0.0035)),
      0.22,
      dark ? [0.04, 0.04, 0.05] : PALETTE.joint,
    );
  }

  addEdgeWear(surface, wearNoise, dark ? 0.2 : 0.42, 0.09);
  return surface;
}

/**
 * The neck.
 *
 * A small piece, but its absence was immediately visible: without it the head
 * floated a clear gap above the chest.
 */
function makeNeck(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.015);
  const width = px(dimensions.neckWidth) + pad * 2;
  const height = px(dimensions.neckLength * 2.4) + pad * 2;
  const surface = createSurface(width, height);
  const cx = width / 2;

  fillSdf(
    surface,
    sdCapsule(cx, pad + px(0.012), cx, height - pad - px(0.012), px(dimensions.neckWidth) * 0.46),
    { ...frameStyle(), metallic: 1, roughness: 0.3 },
  );
  return surface;
}

/** The hand: a mitten silhouette with a separated thumb. */
function makeHand(dark = false): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.02);
  const width = px(dimensions.handWidth * 1.6) + pad * 2;
  const height = px(dimensions.handLength) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const topY = pad;

  fillSdf(surface, sdCircle(cx, topY + px(0.022), px(0.030)), frameStyle(dark));

  // Palm and fingers as one blended form. Individual fingers would be
  // sub-pixel at gameplay scale and only add noise.
  fillSdf(
    surface,
    smoothUnion(
      px(0.012),
      sdRoundedBox(cx, topY + px(0.062), px(0.036), px(0.038), px(0.018)),
      sdRoundedBox(cx + px(0.004), topY + px(0.115), px(0.030), px(0.032), px(0.016)),
    ),
    shellStyle(dark),
  );

  // Thumb.
  fillSdf(
    surface,
    sdCapsule(cx - px(0.032), topY + px(0.058), cx - px(0.046), topY + px(0.098), px(0.015)),
    shellStyle(dark),
  );

  addEdgeWear(surface, wearNoise, dark ? 0.15 : 0.28, 0.1);
  return surface;
}

/** The backpack: houses the power core, and carries a strong cyan accent. */
function makeBackpack(): Surface {
  const dimensions = OPTIMUS_DIMENSIONS;
  const pad = px(0.03);
  const width = px(dimensions.backpackWidth) + pad * 2;
  const height = px(dimensions.backpackHeight) + pad * 2;
  const surface = createSurface(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const halfW = px(dimensions.backpackWidth) / 2;
  const halfH = px(dimensions.backpackHeight) / 2;

  fillSdf(surface, sdRoundedBox(cx, cy, halfW * 0.95, halfH * 0.95, halfW * 0.3), frameStyle());
  fillSdf(
    surface,
    sdRoundedBox(cx - halfW * 0.08, cy, halfW * 0.72, halfH * 0.82, halfW * 0.28),
    { ...shellStyle(), color: [0.45, 0.46, 0.50], rimColor: [0.72, 0.73, 0.78] },
  );

  // Core vent: a stack of glowing slots.
  for (let i = 0; i < 3; i++) {
    const y = cy + (i - 1) * halfH * 0.4;
    paintEmissive(
      surface,
      sdRoundedBox(cx - halfW * 0.08, y, halfW * 0.42, px(0.010), px(0.005)),
      Math.max(2, px(0.014)),
      PALETTE.cyan,
      0.9,
    );
  }

  addEdgeWear(surface, wearNoise, 0.3, 0.06);
  return surface;
}

/** A shoulder pauldron, blended over the arm's joint. */
function makeShoulder(dark = false): Surface {
  const pad = px(0.02);
  const width = px(0.17) + pad * 2;
  const height = px(0.15) + pad * 2;
  const surface = createSurface(width, height);
  const cx = width / 2;
  const cy = height / 2;

  fillSdf(surface, sdCircle(cx, cy, px(0.070)), frameStyle(dark));
  fillSdf(
    surface,
    union(
      sdCircle(cx, cy - px(0.008), px(0.060)),
      sdRoundedBox(cx, cy + px(0.020), px(0.052), px(0.034), px(0.020)),
    ),
    { ...shellStyle(dark), dome: 0.8 },
  );

  addEdgeWear(surface, wearNoise, dark ? 0.18 : 0.32, 0.07);
  return surface;
}

/**
 * Builds every Optimus atlas entry.
 *
 * Naming follows `optimus.<part>` and `optimus.<part>Far` for the far-side
 * copy of a paired limb.
 */
export function buildOptimusAtlasSources(): AtlasSource[] {
  const d = OPTIMUS_DIMENSIONS;
  const sources: AtlasSource[] = [];

  const add = (name: string, surface: Surface, widthMetres: number, pivotX = 0.5, pivotY = 0.5): void => {
    sources.push({ name, surface, widthMetres, pivotX, pivotY });
  };

  // Padding was added around each part, so the sprite's world width is the
  // part's width plus that padding converted back into metres.
  const padded = (metres: number, padMetres: number): number => metres + padMetres * 2;

  add('optimus.head', makeHead(), padded(d.headWidth, 0.03));
  add('optimus.neck', makeNeck(), padded(d.neckWidth, 0.015));
  add('optimus.chest', makeChest(), padded(d.chestWidth, 0.04));
  add('optimus.abdomen', makeAbdomen(), padded(d.abdomenWidth, 0.03));
  add('optimus.pelvis', makePelvis(), padded(d.pelvisWidth, 0.03));
  add('optimus.backpack', makeBackpack(), padded(d.backpackWidth, 0.03));

  for (const [suffix, dark] of [
    ['', false],
    ['Far', true],
  ] as const) {
    add(`optimus.shoulder${suffix}`, makeShoulder(dark), padded(0.17, 0.02));
    add(
      `optimus.upperArm${suffix}`,
      makeLimbSegment(d.upperArmLength, d.upperArmWidth, { dark, actuator: true, accent: true }),
      padded(d.upperArmWidth, 0.035),
    );
    add(
      `optimus.forearm${suffix}`,
      makeLimbSegment(d.forearmLength, d.forearmWidth, { dark, actuator: true }),
      padded(d.forearmWidth, 0.035),
    );
    add(`optimus.hand${suffix}`, makeHand(dark), padded(d.handWidth * 1.6, 0.02));
    add(
      `optimus.thigh${suffix}`,
      makeLimbSegment(d.thighLength, d.thighWidth, { dark, actuator: true, accent: true, taper: 0.78 }),
      padded(d.thighWidth, 0.035),
    );
    add(
      `optimus.shin${suffix}`,
      makeLimbSegment(d.shinLength, d.shinWidth, { dark, actuator: true, taper: 0.74 }),
      padded(d.shinWidth, 0.035),
    );
    add(`optimus.foot${suffix}`, makeFoot(dark), padded(d.footLength, 0.025));
  }

  return sources;
}
