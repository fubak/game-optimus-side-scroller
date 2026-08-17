/**
 * Unlit backdrop: sky gradient, parallax layers, and the atmospheric scrim over them.
 *
 * None of this is lit by the deferred pass — it is scenery behind the playfield, drawn straight
 * into the background target that the lighting pass later composites underneath the lit G-buffer
 * (see `GlWorldRenderer`). Layer canvases come from `src/render/parallax.ts` (the same procedural
 * generator Classic uses) and are uploaded once per level as textures; per-frame work is just a
 * handful of small textured-quad draws, matching `drawParallax`'s wrap-around blit exactly but on
 * the GPU instead of through `CanvasRenderingContext2D.drawImage`.
 */

import type { ParallaxLayer } from '../parallax';
import { Program } from './program';
import { Filter, TexFormat, Texture, Wrap } from './texture';

const SKY_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
out vec2 v_local;
void main() {
  v_local = a_unit;
  vec2 clip = vec2(a_unit.x * 2.0 - 1.0, 1.0 - a_unit.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_local;
uniform vec3 u_top;
uniform vec3 u_mid;
uniform vec3 u_bottom;
out vec4 outColor;
void main() {
  vec3 color = v_local.y < 0.7
    ? mix(u_top, u_mid, v_local.y / 0.7)
    : mix(u_mid, u_bottom, (v_local.y - 0.7) / 0.3);
  outColor = vec4(color, 1.0);
}
`;

const LAYER_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
uniform vec2 u_view;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  vec2 screenPos = u_rect.xy + a_unit * u_rect.zw;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_unit;
}
`;

const LAYER_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`;

const SOLID_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}
`;

const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

/** One uploaded parallax layer: its texture plus the scroll factors from `createParallaxLayers`. */
interface UploadedLayer {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
  readonly factor: number;
  readonly offsetY: number;
  readonly verticalFactor: number;
}

function makeQuadVao(gl: WebGL2RenderingContext, program: Program, buffer: WebGLBuffer): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const location = program.attribLocation('a_unit');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

/**
 * Draws the sky gradient, procedural parallax layers, and the atmospheric scrim into whichever
 * framebuffer is currently bound (the background render target — see `GlWorldRenderer`).
 */
export class BackgroundBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly skyProgram: Program;
  private readonly layerProgram: Program;
  private readonly solidProgram: Program;
  private readonly quadBuffer: WebGLBuffer;
  private readonly skyVao: WebGLVertexArrayObject;
  private readonly layerVao: WebGLVertexArrayObject;
  private readonly solidVao: WebGLVertexArrayObject;

  private layers: UploadedLayer[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.skyProgram = new Program(gl, SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER);
    this.layerProgram = new Program(gl, LAYER_VERTEX_SHADER, LAYER_FRAGMENT_SHADER);
    this.solidProgram = new Program(gl, LAYER_VERTEX_SHADER, SOLID_FRAGMENT_SHADER);

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD_VERTICES, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.skyVao = makeQuadVao(gl, this.skyProgram, this.quadBuffer);
    this.layerVao = makeQuadVao(gl, this.layerProgram, this.quadBuffer);
    this.solidVao = makeQuadVao(gl, this.solidProgram, this.quadBuffer);
  }

  /** Replace the uploaded parallax layers (called once per level, not per frame). */
  setLayers(layers: readonly ParallaxLayer[]): void {
    for (const layer of this.layers) layer.texture.dispose();
    this.layers = layers.map((layer) => {
      const texture = new Texture(this.gl, TexFormat.RGBA8, { filter: Filter.Nearest, wrap: Wrap.Clamp });
      texture.uploadImage(layer.canvas, layer.canvas.width, layer.canvas.height);
      return {
        texture,
        width: layer.canvas.width,
        height: layer.canvas.height,
        factor: layer.factor,
        offsetY: layer.offsetY,
        verticalFactor: layer.verticalFactor,
      };
    });
  }

  /** Sky gradient, filling whichever viewport is currently bound. Colours are 0-1 RGB triples. */
  drawSky(
    top: readonly [number, number, number],
    mid: readonly [number, number, number],
    bottom: readonly [number, number, number],
  ): void {
    const { gl } = this;
    this.skyProgram.use();
    this.skyProgram.setUniform3f('u_top', top[0], top[1], top[2]);
    this.skyProgram.setUniform3f('u_mid', mid[0], mid[1], mid[2]);
    this.skyProgram.setUniform3f('u_bottom', bottom[0], bottom[1], bottom[2]);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Draw every uploaded parallax layer, wrapping horizontally exactly like `drawParallax`. */
  drawLayers(viewWidth: number, viewHeight: number, cameraX: number, cameraY: number): void {
    const { gl } = this;
    this.layerProgram.use();
    this.layerProgram.setUniform2f('u_view', viewWidth, viewHeight);
    this.layerProgram.setUniform1i('u_tex', 0);
    gl.bindVertexArray(this.layerVao);
    for (const layer of this.layers) {
      layer.texture.bind(0);
      const layerWidth = layer.width;
      const scrolled = (((cameraX * layer.factor) % layerWidth) + layerWidth) % layerWidth;
      const y = layer.offsetY - cameraY * layer.verticalFactor;
      this.layerProgram.setUniform4f('u_rect', -scrolled, y, layerWidth, layer.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.layerProgram.setUniform4f('u_rect', -scrolled + layerWidth, y, layerWidth, layer.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  /** Flat translucent rect over the whole view (the "atmospheric scrim" between backdrop and terrain). */
  drawScrim(viewWidth: number, viewHeight: number, r: number, g: number, b: number, a: number): void {
    const { gl } = this;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.solidProgram.use();
    this.solidProgram.setUniform2f('u_view', viewWidth, viewHeight);
    this.solidProgram.setUniform4f('u_rect', 0, 0, viewWidth, viewHeight);
    this.solidProgram.setUniform4f('u_color', r, g, b, a);
    gl.bindVertexArray(this.solidVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    const { gl } = this;
    for (const layer of this.layers) layer.texture.dispose();
    this.layers = [];
    gl.deleteVertexArray(this.skyVao);
    gl.deleteVertexArray(this.layerVao);
    gl.deleteVertexArray(this.solidVao);
    gl.deleteBuffer(this.quadBuffer);
    this.skyProgram.dispose();
    this.layerProgram.dispose();
    this.solidProgram.dispose();
  }
}
