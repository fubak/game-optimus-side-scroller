/**
 * Fullscreen textured blit.
 *
 * Stage 1 of the GL pipeline presents the scene by uploading a CPU-rendered colour buffer and
 * drawing it as a single textured quad. Later stages replace the upload with G-buffer / lighting
 * targets, but keep this same present path (and the same y-flip) so the compositor contract stays
 * stable.
 */

import { Program } from './program';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // a_pos is a clip-space full-screen triangle strip corner in [-1,1].
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  // Canvas2D buffers are top-left origin; GL textures are bottom-left. Flip V on sample.
  outColor = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
}
`;

/** Clip-space triangle covering the viewport (two verts shared via TRIANGLE_STRIP). */
const FULLSCREEN_POS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export class FullscreenBlit {
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
    const loc = this.program.attribLocation('a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Draw `texture` to the currently bound framebuffer (usually the default/backbuffer). */
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
