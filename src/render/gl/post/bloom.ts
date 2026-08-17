/**
 * Dual-filter ("dual Kawase") bloom, sourced from the G-buffer's emissive channel only.
 *
 * Thresholds the emissive buffer (self-illuminated surfaces — the goal, energy cells, muzzle
 * flashes — never terrain lit only by ambient/point lights) and blurs it through a small mip chain
 * of alternating downsample/upsample passes. Each pass is a handful of bilinear texture taps, so a
 * soft, wide-radius glow costs a fixed, tiny number of fullscreen draws regardless of how bright or
 * large the source highlight is — the classic trick from Marius Bjørge's "Bandwidth-Efficient
 * Rendering" (SIGGRAPH 2015), also used by Godot's glow implementation. Sourcing from the emissive
 * buffer instead of a bright-pass of the final lit image also means terrain grazed by a point light
 * never blooms — only things that are actually self-lit do.
 *
 * Pipeline per {@link draw} call, all at fixed sizes set up once in the constructor (no per-frame
 * allocation, and no resize support: the deferred pipeline's internal targets are pinned to
 * `INTERNAL_WIDTH`x`INTERNAL_HEIGHT`, see `GlWorldRenderer`):
 *
 *  1. threshold + downsample the emissive texture into `mips[0]` (half the source size)
 *  2. downsample `mips[i]` into `mips[i+1]` for the rest of the chain (each half the previous)
 *  3. upsample the smallest mip back up the chain, additively blending onto each larger mip's own
 *     (still-present) down-pass content
 *  4. upsample `mips[0]` one more time, additively, directly onto {@link BloomInputs.compositeInto}
 *     — whichever render target the deferred pass's HDR/LDR accumulation buffer already is
 */

import { Program } from '../program';
import { RenderTarget } from '../renderTarget';
import { Filter, TexFormat } from '../texture';
import type { Texture } from '../texture';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Soft-thresholds each of the classic 5-tap dual-Kawase downsample's samples, then averages. */
const THRESHOLD_DOWN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_halfTexel;
uniform float u_threshold;
out vec4 outColor;

vec3 bright(vec2 uv) {
  return max(texture(u_tex, uv).rgb - u_threshold, 0.0);
}

void main() {
  vec2 h = u_halfTexel;
  vec3 sum = bright(v_uv) * 4.0;
  sum += bright(v_uv - h);
  sum += bright(v_uv + h);
  sum += bright(v_uv + vec2(h.x, -h.y));
  sum += bright(v_uv - vec2(h.x, -h.y));
  outColor = vec4(sum / 8.0, 1.0);
}
`;

/** Dual-Kawase downsample: 5 bilinear taps standing in for a much larger box filter. */
const DOWN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_halfTexel;
out vec4 outColor;

void main() {
  vec2 h = u_halfTexel;
  vec3 sum = texture(u_tex, v_uv).rgb * 4.0;
  sum += texture(u_tex, v_uv - h).rgb;
  sum += texture(u_tex, v_uv + h).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, -h.y)).rgb;
  sum += texture(u_tex, v_uv - vec2(h.x, -h.y)).rgb;
  outColor = vec4(sum / 8.0, 1.0);
}
`;

/** Dual-Kawase upsample: an 8-tap tent filter, scaled by `u_intensity` for the final composite. */
const UP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_halfTexel;
uniform float u_intensity;
out vec4 outColor;

void main() {
  vec2 h = u_halfTexel;
  vec3 sum = texture(u_tex, v_uv + vec2(-h.x * 2.0, 0.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(-h.x, h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, h.y * 2.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(h.x * 2.0, 0.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, -h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, -h.y * 2.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4((sum / 12.0) * u_intensity, 1.0);
}
`;

const FULLSCREEN_POS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

/** Mip chain depth. Four halvings of a 480x270 source lands the smallest level at ~30x17. */
const MIP_LEVELS = 4;

export interface BloomInputs {
  /** G-buffer emissive texture (see `GlWorldRenderer`); the only thing this pass reads from. */
  readonly emissive: Texture;
  /** Soft-threshold cutoff (0-1ish; emissive can exceed 1 with HDR, so this is not hard-clamped). */
  readonly threshold: number;
  /** Overall bloom brightness multiplier for the final additive composite. */
  readonly intensity: number;
  /** Render target to additively composite the blurred highlight onto (kept bound on return). */
  readonly compositeInto: RenderTarget;
}

export class BloomPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly thresholdProgram: Program;
  private readonly downProgram: Program;
  private readonly upProgram: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly mips: RenderTarget[] = [];

  constructor(gl: WebGL2RenderingContext, baseWidth: number, baseHeight: number) {
    this.gl = gl;
    this.thresholdProgram = new Program(gl, VERTEX_SHADER, THRESHOLD_DOWN_FRAGMENT);
    this.downProgram = new Program(gl, VERTEX_SHADER, DOWN_FRAGMENT);
    this.upProgram = new Program(gl, VERTEX_SHADER, UP_FRAGMENT);

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_POS, gl.STATIC_DRAW);
    // All three programs share the same `a_pos` fullscreen-triangle-strip attribute layout, so one
    // VAO/VBO pair (bound once per draw call below) serves every pass in the chain.
    const posLocation = this.thresholdProgram.attribLocation('a_pos');
    gl.enableVertexAttribArray(posLocation);
    gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let width = baseWidth;
    let height = baseHeight;
    for (let i = 0; i < MIP_LEVELS; i += 1) {
      width = Math.max(1, Math.round(width / 2));
      height = Math.max(1, Math.round(height / 2));
      // Bilinear filtering is load-bearing here: the dual-Kawase taps rely on hardware interpolation
      // between texels to approximate a much wider kernel from only 5-8 samples.
      const target = new RenderTarget(gl, [
        { format: TexFormat.RGBA8, clear: [0, 0, 0, 1], filter: Filter.Linear },
      ]);
      target.resize(width, height);
      this.mips.push(target);
    }
  }

  /** Blurs {@link BloomInputs.emissive} and adds it onto {@link BloomInputs.compositeInto}. */
  draw(inputs: BloomInputs): void {
    const { gl } = this;
    const first = this.mips[0];
    if (first === undefined) return;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    this.runFullscreen(this.thresholdProgram, first, inputs.emissive, () => {
      this.thresholdProgram.setUniform2f('u_halfTexel', 0.5 / inputs.emissive.width, 0.5 / inputs.emissive.height);
      this.thresholdProgram.setUniform1f('u_threshold', inputs.threshold);
    });

    for (let i = 0; i < this.mips.length - 1; i += 1) {
      const source = this.mips[i];
      const dest = this.mips[i + 1];
      if (source === undefined || dest === undefined) continue;
      this.runFullscreen(this.downProgram, dest, source.texture, () => {
        this.downProgram.setUniform2f('u_halfTexel', 0.5 / source.width, 0.5 / source.height);
      });
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.mips.length - 1; i > 0; i -= 1) {
      const source = this.mips[i];
      const dest = this.mips[i - 1];
      if (source === undefined || dest === undefined) continue;
      this.runFullscreen(this.upProgram, dest, source.texture, () => {
        this.upProgram.setUniform2f('u_halfTexel', 0.5 / source.width, 0.5 / source.height);
        this.upProgram.setUniform1f('u_intensity', 1);
      });
    }

    // Final upsample: additively composite straight onto the scene, scaled by the user-facing
    // intensity (the intermediate steps above always use 1 — only the visible result is scaled).
    inputs.compositeInto.bind();
    this.upProgram.use();
    this.upProgram.setUniform1i('u_tex', 0);
    this.upProgram.setUniform2f('u_halfTexel', 0.5 / first.width, 0.5 / first.height);
    this.upProgram.setUniform1f('u_intensity', inputs.intensity);
    first.texture.bind(0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private runFullscreen(program: Program, target: RenderTarget, source: Texture, setUniforms: () => void): void {
    const { gl } = this;
    target.bind();
    program.use();
    program.setUniform1i('u_tex', 0);
    source.bind(0);
    setUniforms();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    const { gl } = this;
    for (const mip of this.mips) mip.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    this.thresholdProgram.dispose();
    this.downProgram.dispose();
    this.upProgram.dispose();
  }
}
