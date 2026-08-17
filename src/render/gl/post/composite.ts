/**
 * Final composite pass: tonemap (ACES or AgX) plus optional vignette / filmic grain / chromatic
 * aberration, and an always-on dither — in one fullscreen fragment shader, so the deferred
 * pipeline's present step costs exactly one draw call no matter how many of those effects are
 * active. `GlWorldRenderer` decides which booleans to pass (quality preset, individual settings
 * toggles, reduced motion); this pass itself performs no per-frame allocation — every value it
 * reads is a primitive uniform, and the fullscreen quad's VAO/VBO are created once in the
 * constructor, mirroring `TonemapPass`.
 *
 * Effect notes:
 * - **Chromatic aberration** samples the source texture's R/G/B channels at slightly different UVs,
 *   offset by distance from screen centre, so the shift is negligible in the middle and only
 *   noticeable right at the edges.
 * - **Grain** is a per-pixel, per-frame luminance hash — high spatial frequency, animated at the
 *   frame rate, and low amplitude. That reads as film texture, not as the kind of low-frequency
 *   full-screen brightness flashing photosensitivity guidance warns about, so it is safe to leave
 *   animated even though it changes every frame; it is still fully disabled under reduced motion
 *   (see `settings.withReducedMotion`) for players who would rather not have any of it.
 * - **Dither** (an interleaved-gradient-noise offset applied just before quantisation) is always on
 *   regardless of quality/settings — it exists purely to break up 8-bit banding in the tonemapped
 *   output and is imperceptible on its own.
 * - **AgX** is the "minimal AgX" approximation popularised by Benjamin Wrensch/Troy Sobotka's
 *   circle (inset matrix → log2 encode → polynomial sigmoid → outset matrix), not the reference
 *   OCIO transform — a deliberately cheap, LUT-free approximation, good enough for a creative
 *   "punchier highlights" alternative to the ACES fit already in `tonemap.ts`.
 */

import type { TonemapOperator } from '../../settings';
import { Program } from '../program';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_tonemap;
uniform int u_vignette;
uniform int u_grain;
uniform int u_chromaticAberration;
uniform float u_time;
out vec4 outColor;

/** Narkowicz 2015 ACES fit — identical to the one in \`tonemap.ts\`. */
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Minimal AgX approximation (inset/outset matrices + polynomial sigmoid), no LUT. Coefficients
// from the widely-used glsl-tone-map / "Missing Deadlines" (Benjamin Wrensch) port of Blender's
// AgX, itself derived from Troy Sobotka's AgX — see the module doc for context.
const mat3 AGX_INSET = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859
);
const mat3 AGX_OUTSET = mat3(
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
);
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxFilm(vec3 color) {
  color = AGX_INSET * color;
  color = max(color, 1e-10);
  color = clamp(log2(color), AGX_MIN_EV, AGX_MAX_EV);
  color = (color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  color = clamp(color, 0.0, 1.0);

  vec3 x2 = color * color;
  vec3 x4 = x2 * x2;
  color = 15.5 * x4 * x2 - 40.14 * x4 * color + 31.96 * x4 - 6.868 * x2 * color + 0.4298 * x2 + 0.1191 * color - 0.00232;

  color = AGX_OUTSET * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(color, 0.0, 1.0);
}

/** Dave Hoskins-style "hash without sine" — cheap, no texture lookup, good enough for grain. */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Jorge Jimenez's interleaved gradient noise — a cheap, well-distributed dither source. */
float interleavedGradientNoise(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec2 uv = v_uv;
  vec3 hdr;
  if (u_chromaticAberration == 1) {
    vec2 dir = uv - 0.5;
    vec2 offset = dir * 0.006 * dot(dir, dir) * 4.0;
    hdr = vec3(
      texture(u_tex, uv - offset).r,
      texture(u_tex, uv).g,
      texture(u_tex, uv + offset).b
    );
  } else {
    hdr = texture(u_tex, uv).rgb;
  }

  vec3 mapped = u_tonemap == 1 ? agxFilm(hdr) : acesFilm(hdr);

  if (u_vignette == 1) {
    float dist = length(uv - 0.5);
    float vignette = smoothstep(0.85, 0.35, dist);
    mapped *= mix(0.72, 1.0, vignette);
  }

  if (u_grain == 1) {
    float grain = hash12(gl_FragCoord.xy + u_time * 97.0) - 0.5;
    mapped += grain * 0.035;
  }

  float dither = (interleavedGradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  mapped += dither;

  outColor = vec4(clamp(mapped, 0.0, 1.0), 1.0);
}
`;

const FULLSCREEN_POS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

/** Maps the settings-facing operator name to the shader's `u_tonemap` uniform value. */
export function tonemapOperatorIndex(operator: TonemapOperator): number {
  switch (operator) {
    case 'aces':
      return 0;
    case 'agx':
      return 1;
    default: {
      const exhaustive: never = operator;
      throw new Error(`Unhandled tonemap operator: ${String(exhaustive)}`);
    }
  }
}

export interface CompositeInputs {
  readonly tonemap: TonemapOperator;
  readonly vignette: boolean;
  readonly grain: boolean;
  readonly chromaticAberration: boolean;
  /** Seconds since the renderer started; seeds the grain hash. Wrapped by the caller, not here. */
  readonly timeSec: number;
}

/**
 * Fullscreen tonemap + vignette/grain/chromatic-aberration/dither composite.
 *
 * Draws to whichever framebuffer is currently bound, exactly like `TonemapPass` (which this
 * replaces on the deferred pipeline's main present path — `TonemapPass` itself is kept only for
 * the raw G-buffer channel debug view, see `GlWorldRenderer`).
 */
export class CompositePass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new Program(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_POS, gl.STATIC_DRAW);
    const location = this.program.attribLocation('a_pos');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(texture: WebGLTexture, inputs: CompositeInputs, unit = 0): void {
    const { gl } = this;
    this.program.use();
    this.program.setUniform1i('u_tex', unit);
    this.program.setUniform1i('u_tonemap', tonemapOperatorIndex(inputs.tonemap));
    this.program.setUniform1i('u_vignette', inputs.vignette ? 1 : 0);
    this.program.setUniform1i('u_grain', inputs.grain ? 1 : 0);
    this.program.setUniform1i('u_chromaticAberration', inputs.chromaticAberration ? 1 : 0);
    this.program.setUniform1f('u_time', inputs.timeSec);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    this.program.dispose();
  }
}
