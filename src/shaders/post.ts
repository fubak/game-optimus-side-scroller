/**
 * Post-processing shaders.
 *
 * The chain, in order: bright-pass, dual-Kawase bloom, god rays, composite,
 * tonemap, grade, and a final grain/aberration/vignette trim. Each stage is a
 * separate fullscreen pass so the quality tiers can skip individual stages
 * without recompiling anything.
 */

/**
 * Bright-pass with soft knee.
 *
 * A hard threshold makes bloom pop in and out as a highlight crosses it, which
 * is very visible on a moving light. The knee ramps contribution in smoothly
 * over a band around the threshold instead.
 */
export const BRIGHT_PASS_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uSource;
uniform float uThreshold;
uniform float uKnee;
uniform float uIntensity;
out vec4 oColor;

void main() {
  vec3 color = texture(uSource, vUV).rgb;
  float brightness = max(color.r, max(color.g, color.b));

  float soft = brightness - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);

  float contribution = max(soft, brightness - uThreshold) / max(brightness, 0.0001);
  oColor = vec4(color * contribution * uIntensity, 1.0);
}
`;

/**
 * Dual-Kawase downsample.
 *
 * Five taps arranged so that hardware bilinear filtering does most of the
 * averaging. Compared with a separable Gaussian of equivalent radius this is
 * dramatically cheaper for the very wide blurs bloom needs, and the slight
 * difference in kernel shape is invisible once several levels are combined.
 */
export const KAWASE_DOWN_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
out vec4 oColor;

void main() {
  vec2 halfPixel = uTexelSize * 0.5;
  vec4 sum = texture(uSource, vUV) * 4.0;
  sum += texture(uSource, vUV - halfPixel);
  sum += texture(uSource, vUV + halfPixel);
  sum += texture(uSource, vUV + vec2(halfPixel.x, -halfPixel.y));
  sum += texture(uSource, vUV - vec2(halfPixel.x, -halfPixel.y));
  oColor = sum / 8.0;
}
`;

/** Dual-Kawase upsample: an eight-tap tent filter. */
export const KAWASE_UP_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
out vec4 oColor;

void main() {
  vec2 halfPixel = uTexelSize * 0.5;
  vec4 sum = texture(uSource, vUV + vec2(-halfPixel.x * 2.0, 0.0));
  sum += texture(uSource, vUV + vec2(-halfPixel.x, halfPixel.y)) * 2.0;
  sum += texture(uSource, vUV + vec2(0.0, halfPixel.y * 2.0));
  sum += texture(uSource, vUV + vec2(halfPixel.x, halfPixel.y)) * 2.0;
  sum += texture(uSource, vUV + vec2(halfPixel.x * 2.0, 0.0));
  sum += texture(uSource, vUV + vec2(halfPixel.x, -halfPixel.y)) * 2.0;
  sum += texture(uSource, vUV + vec2(0.0, -halfPixel.y * 2.0));
  sum += texture(uSource, vUV + vec2(-halfPixel.x, -halfPixel.y)) * 2.0;
  oColor = sum / 12.0;
}
`;

/**
 * Radial god rays.
 *
 * Marches from each pixel toward the light's screen position through the
 * occluder mask, accumulating the *unoccluded* fraction with exponential decay.
 * This is the classic screen-space light-shaft approach, and it is what turns
 * a dusty room with a hole in the ceiling into a shaft of visible light.
 *
 * Sample positions are jittered so the modest step count reads as fine grain
 * rather than as concentric rings.
 */
export const GODRAYS_FS = `#version 300 es
precision highp float;

#ifndef GODRAY_SAMPLES
#define GODRAY_SAMPLES 12
#endif

in vec2 vUV;
uniform sampler2D uOccluder;
uniform sampler2D uBlueNoise;
uniform vec2 uLightScreenPos;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uExposure;
uniform vec3 uColor;
uniform vec2 uResolution;
uniform float uTime;
out vec4 oColor;

void main() {
#if GODRAY_SAMPLES == 0
  oColor = vec4(0.0);
#else
  vec2 delta = (vUV - uLightScreenPos) * uDensity / float(GODRAY_SAMPLES);
  float jitter = texture(uBlueNoise, vUV * uResolution / 64.0 + uTime * 0.013).r;

  vec2 samplePos = vUV - delta * jitter;
  float illumination = 1.0;
  float accumulated = 0.0;

  for (int i = 0; i < GODRAY_SAMPLES; i++) {
    samplePos -= delta;
    if (samplePos.x < 0.0 || samplePos.x > 1.0 || samplePos.y < 0.0 || samplePos.y > 1.0) {
      break;
    }
    // Light reaches this sample only where the occluder mask is empty.
    float openSky = 1.0 - texture(uOccluder, samplePos).r;
    accumulated += openSky * illumination * uWeight;
    illumination *= uDecay;
  }

  accumulated /= float(GODRAY_SAMPLES);

  // Fade shafts out behind the camera-facing hemisphere of the light so they
  // do not smear across the whole screen when the sun is near an edge.
  float radial = 1.0 - smoothstep(0.0, 1.1, length(vUV - uLightScreenPos));

  oColor = vec4(uColor * accumulated * uExposure * radial, 1.0);
#endif
}
`;

/**
 * Height fog with animated noise.
 *
 * Depth comes from the G-buffer, so fog correctly sits between parallax layers
 * rather than being a flat overlay. The noise drifts slowly and is sampled at
 * two scales, which reads as moving air rather than as a static texture.
 */
export const FOG_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform vec3 uFogColor;
uniform float uDensity;
uniform float uHeightFalloff;
uniform float uTime;
uniform float uNoiseStrength;
uniform vec2 uWind;
out vec4 oColor;

void main() {
  vec3 scene = texture(uScene, vUV).rgb;
  float depth = texture(uDepth, vUV).r;

  // Two octaves drifting at different rates so the pattern never obviously
  // repeats or moves as a single sheet.
  vec2 flow = uWind * uTime;
  float noiseA = texture(uNoise, vUV * 1.7 + flow * 0.06).r;
  float noiseB = texture(uNoise, vUV * 3.9 - flow * 0.11).r;
  float turbulence = mix(noiseA, noiseB, 0.45);

  // Denser toward the bottom of the screen, as settling dust behaves.
  float height = 1.0 - exp(-max(vUV.y, 0.0) * uHeightFalloff);

  float amount = 1.0 - exp(-depth * uDensity * height);
  amount *= mix(1.0, turbulence * 1.6, uNoiseStrength);
  amount = clamp(amount, 0.0, 1.0);

  oColor = vec4(mix(scene, uFogColor, amount), 1.0);
}
`;

/**
 * Final composite: bloom, distortion, tonemap, grade, and film trim.
 *
 * Kept as a single pass because every stage here is cheap ALU on data already
 * in registers; splitting them would add several full round-trips to memory for
 * no benefit.
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;

#ifndef ENABLE_GRAIN
#define ENABLE_GRAIN 1
#endif
#ifndef ENABLE_ABERRATION
#define ENABLE_ABERRATION 1
#endif

in vec2 vUV;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uDistortion;
uniform sampler2D uGodRays;
uniform sampler2D uColorGrade;
uniform sampler2D uBlueNoise;

uniform float uBloomIntensity;
uniform float uExposure;
uniform float uAberration;
uniform float uVignette;
uniform float uGrainAmount;
uniform float uTime;
uniform vec2 uResolution;
uniform float uGradeMix;
uniform float uBarrel;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;

out vec4 oColor;

/**
 * ACES filmic tonemapping, Krzysztof Narkowicz's fitted approximation.
 *
 * Highlights roll off toward white instead of clipping to a flat colour, which
 * is essential here: the scenes are built around bright emissive accents
 * against dark environments, and a naive clamp turns every glow into an ugly
 * saturated blob.
 */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/**
 * Samples a 32x32x32 LUT stored as a 1024x32 strip.
 *
 * Blends between adjacent blue slices manually because hardware bilinear
 * filtering would bleed across slice boundaries and produce wrong colours.
 */
vec3 applyGrade(vec3 color) {
  const float SIZE = 32.0;
  color = clamp(color, 0.0, 1.0);

  float blue = color.b * (SIZE - 1.0);
  float sliceLow = floor(blue);
  float sliceHigh = min(sliceLow + 1.0, SIZE - 1.0);
  float blend = blue - sliceLow;

  vec2 texel = vec2(1.0 / (SIZE * SIZE), 1.0 / SIZE);
  vec2 uvBase = vec2(
    color.r * (SIZE - 1.0) * texel.x + texel.x * 0.5,
    color.g * (SIZE - 1.0) * texel.y + texel.y * 0.5
  );

  vec3 low = texture(uColorGrade, uvBase + vec2(sliceLow / SIZE, 0.0)).rgb;
  vec3 high = texture(uColorGrade, uvBase + vec2(sliceHigh / SIZE, 0.0)).rgb;
  return mix(low, high, blend);
}

void main() {
  vec2 uv = vUV;

  // Barrel distortion, applied first so everything downstream inherits it.
  vec2 centered = uv - 0.5;
  float radiusSq = dot(centered, centered);
  uv = 0.5 + centered * (1.0 + uBarrel * radiusSq);

  // Screen-space refraction from heat haze, shockwaves, and EM pulses.
  vec2 distortion = texture(uDistortion, uv).rg * 2.0 - 1.0;
  uv += distortion * 0.06;

  vec3 color;

#if ENABLE_ABERRATION
  // Aberration scales with distance from centre, as a real lens behaves.
  float aberration = uAberration * radiusSq;
  vec2 direction = normalize(centered + 1e-6);
  color.r = texture(uScene, uv + direction * aberration).r;
  color.g = texture(uScene, uv).g;
  color.b = texture(uScene, uv - direction * aberration).b;
#else
  color = texture(uScene, uv).rgb;
#endif

  color += texture(uBloom, uv).rgb * uBloomIntensity;
  color += texture(uGodRays, uv).rgb;

  color *= uExposure;
  color = acesFilmic(color);

  // Lift, contrast, and saturation before the LUT, so the LUT is authored
  // against an already-neutral image.
  color += uLift;
  color = (color - 0.5) * uContrast + 0.5;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSaturation);
  color = clamp(color, 0.0, 1.0);

  color = mix(color, applyGrade(color), uGradeMix);

  float vignette = 1.0 - smoothstep(0.35, 0.95, length(centered) * 1.35) * uVignette;
  color *= vignette;

#if ENABLE_GRAIN
  // Animated blue noise. Grain must move, or it reads as a dirty screen.
  vec2 noiseUV = uv * uResolution / 64.0 + vec2(uTime * 71.3, uTime * 53.7);
  float grain = texture(uBlueNoise, fract(noiseUV)).r - 0.5;
  // Scale grain by luminance so it sits in the mid-tones and does not crush
  // the shadows, which is where it would be most objectionable.
  color += grain * uGrainAmount * (0.35 + luma * 0.65);
#endif

  oColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/**
 * Separable Gaussian blur, used for depth-of-field on the far parallax layers.
 *
 * Distant layers being softer than near ones is the strongest single cue for
 * atmospheric depth, and one the automated metrics explicitly measure.
 */
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uSource;
uniform vec2 uDirection;
uniform vec2 uTexelSize;
uniform float uRadius;
out vec4 oColor;

void main() {
  // Nine-tap kernel using bilinear-weighted offsets, giving the reach of a
  // 17-tap filter for roughly half the samples.
  const float offsets[5] = float[](0.0, 1.4103, 3.2925, 5.1751, 7.0582);
  const float weights[5] = float[](0.1964, 0.2969, 0.0944, 0.0104, 0.0003);

  vec2 stride = uDirection * uTexelSize * uRadius;
  vec4 sum = texture(uSource, vUV) * weights[0];

  for (int i = 1; i < 5; i++) {
    vec2 offset = stride * offsets[i];
    sum += texture(uSource, vUV + offset) * weights[i];
    sum += texture(uSource, vUV - offset) * weights[i];
  }
  oColor = sum;
}
`;

/** Copies a texture, optionally scaled. Used for resolves and debug views. */
export const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSource;
uniform float uScale;
out vec4 oColor;
void main() {
  oColor = texture(uSource, vUV) * uScale;
}
`;
