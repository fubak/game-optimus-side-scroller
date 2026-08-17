/**
 * Tonemap present pass.
 *
 * The lighting pass accumulates colour that can exceed 1.0 (bright emissives stacked with several
 * overlapping point lights), so presenting it straight to an 8-bit backbuffer would clip highlights
 * hard. This fullscreen pass applies the ACES filmic tonemap curve (a fixed 3x3 fit good enough for
 * a game this size — see Krzysztof Narkowicz's approximation) followed by a gamma-correct-ish
 * output, then draws into whichever framebuffer is bound (the real backbuffer, sized to the
 * device's resolution — see `GlWorldRenderer`). This is also where low-res render-target contents
 * get upscaled to the display's native size, same as the Stage 1/2 blit it replaces.
 */

import { Program } from './program';

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
out vec4 outColor;

/** Narkowicz 2015 ACES fit: cheap, no LUT, close enough for a 480x270-native pixel-art game. */
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture(u_tex, v_uv).rgb;
  vec3 mapped = acesFilm(hdr);
  outColor = vec4(mapped, 1.0);
}
`;

const FULLSCREEN_POS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

/**
 * Fullscreen ACES tonemap, sampling `unit` 0 of whichever texture is bound.
 *
 * Kept deliberately separate from {@link FullscreenBlit} (which does a plain, tonemap-free copy):
 * Classic's Stage 1 hybrid path never produces HDR values, so it still uses the plain blit, while
 * the deferred pipeline's HDR/LDR accumulation target always goes through this pass.
 */
export class TonemapPass {
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

  /** Tonemap `texture` and draw it to whichever framebuffer/viewport is currently bound. */
  draw(texture: WebGLTexture, unit = 0): void {
    const { gl } = this;
    this.program.use();
    this.program.setUniform1i('u_tex', unit);
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
