/**
 * Unlit backdrop: sky gradient, parallax layers, volumetric light shafts, and the atmospheric
 * scrim over them.
 *
 * None of this is lit by the deferred pass — it is scenery behind the playfield, drawn straight
 * into the background target that the lighting pass later composites underneath the lit G-buffer
 * (see `GlWorldRenderer`). Layer canvases come from `src/render/parallax.ts`'s `'enhanced'`
 * generator (`parallaxEnhanced.ts`) and are uploaded once per level as textures; per-frame work is
 * just a handful of small textured-quad draws, matching `drawParallax`'s wrap-around blit exactly
 * but on the GPU instead of through `CanvasRenderingContext2D.drawImage`. A layer's texture may be
 * higher resolution than the screen-space rect it is drawn into (`ParallaxLayer.width`/`height` vs
 * `canvas.width`/`height`) — that hi-res texture is uploaded with linear filtering so the extra
 * detail reads as smooth instead of blocky.
 */

import type { ParallaxLayer } from '../parallax';
import { Program } from './program';
import { Filter, TexFormat, Texture, Wrap } from './texture';

const SHAFT_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
out vec2 v_local;
void main() {
  v_local = a_unit;
  vec2 clip = vec2(a_unit.x * 2.0 - 1.0, 1.0 - a_unit.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

/**
 * A handful of soft, angular god-ray beams fanning down from fixed points near the top of the
 * screen. Each beam is an analytic distance-from-centreline falloff (cheap: no samples, no loop
 * over occluders) — "volumetric" in look only, not simulation. Colours alternate cool
 * cyan/tech-light and warm sodium so the shafts read as industrial floodlights, not an anime sunbeam.
 *
 * Each beam widens gradually as it travels from its origin (`spread`) and uses a wider half-width
 * than a hard-edged wedge would need — combined with the smoothstep falloff already spanning the
 * whole width, this is what keeps the shaft reading as a soft cone of light rather than a
 * flat-sided, hard-edged wedge.
 */
const SHAFT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_local;
uniform float u_intensity;
uniform float u_time;
uniform vec3 u_coolColor;
uniform vec3 u_warmColor;
out vec4 outColor;

float beam(vec2 uv, float originX, float angle, float halfWidth, float falloff, float spread) {
  vec2 dir = vec2(sin(angle), cos(angle));
  vec2 toP = uv - vec2(originX, 0.0);
  float along = dot(toP, dir);
  if (along < 0.0) return 0.0;
  vec2 perp = toP - dir * along;
  float dist = length(perp);
  float width = halfWidth + along * spread;
  float band = smoothstep(width, 0.0, dist);
  return band * exp(-along * falloff);
}

void main() {
  // A very slow drift (a full cycle takes minutes) keeps the shafts from looking static without
  // ever approaching flashing/strobing territory — this uniform is forced to a constant by the
  // caller under reduced motion, so the drift itself is skipped rather than merely slowed.
  float t = u_time * 0.015;
  float b0 = beam(v_local, 0.18 + 0.015 * sin(t), 0.18, 0.075, 1.3, 0.16);
  float b1 = beam(v_local, 0.52 + 0.02 * sin(t * 0.7 + 1.4), -0.12, 0.07, 1.45, 0.18);
  float b2 = beam(v_local, 0.83 + 0.015 * sin(t * 1.2 + 2.7), 0.09, 0.065, 1.6, 0.14);

  vec3 color = b0 * u_coolColor + b1 * u_warmColor + b2 * u_coolColor;
  outColor = vec4(color * u_intensity, 1.0);
}
`;

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
  private readonly shaftProgram: Program;
  private readonly quadBuffer: WebGLBuffer;
  private readonly skyVao: WebGLVertexArrayObject;
  private readonly layerVao: WebGLVertexArrayObject;
  private readonly solidVao: WebGLVertexArrayObject;
  private readonly shaftVao: WebGLVertexArrayObject;

  private layers: UploadedLayer[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.skyProgram = new Program(gl, SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER);
    this.layerProgram = new Program(gl, LAYER_VERTEX_SHADER, LAYER_FRAGMENT_SHADER);
    this.solidProgram = new Program(gl, LAYER_VERTEX_SHADER, SOLID_FRAGMENT_SHADER);
    this.shaftProgram = new Program(gl, SHAFT_VERTEX_SHADER, SHAFT_FRAGMENT_SHADER);

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD_VERTICES, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.skyVao = makeQuadVao(gl, this.skyProgram, this.quadBuffer);
    this.layerVao = makeQuadVao(gl, this.layerProgram, this.quadBuffer);
    this.solidVao = makeQuadVao(gl, this.solidProgram, this.quadBuffer);
    this.shaftVao = makeQuadVao(gl, this.shaftProgram, this.quadBuffer);
  }

  /**
   * Replace the uploaded parallax layers (called once per level, not per frame). A layer's
   * on-screen size comes from {@link ParallaxLayer.width}/{@link ParallaxLayer.height} (logical,
   * screen-space units — see `parallax.ts`), which may be smaller than its `canvas.width`/`height`
   * texel resolution; when it is, the texture is hi-res, so it is uploaded with linear filtering
   * instead of Classic's nearest-neighbour so the extra detail reads as smooth, not blocky.
   */
  setLayers(layers: readonly ParallaxLayer[]): void {
    for (const layer of this.layers) layer.texture.dispose();
    this.layers = layers.map((layer) => {
      const texture = new Texture(this.gl, TexFormat.RGBA8, {
        // Enhanced always samples parallax with linear filtering — even Classic-resolution
        // layers look softer at 4K than nearest (see `docs/art-direction.md`).
        filter: Filter.Linear,
        wrap: Wrap.Clamp,
      });
      texture.uploadImage(layer.canvas, layer.canvas.width, layer.canvas.height);
      return {
        texture,
        width: layer.width,
        height: layer.height,
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

  /**
   * A few soft volumetric-looking light shafts, additively composited over the backdrop so far.
   * `intensity` should already fold in quality/settings and be `0` under reduced motion — this
   * method still runs the (cheap) draw call at `0` rather than special-casing the skip, keeping the
   * caller simple; skip calling it entirely if the caller wants to avoid even that.
   */
  drawLightShafts(
    coolColor: readonly [number, number, number],
    warmColor: readonly [number, number, number],
    intensity: number,
    timeSec: number,
  ): void {
    if (intensity <= 0) return;
    const { gl } = this;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.shaftProgram.use();
    this.shaftProgram.setUniform3f('u_coolColor', coolColor[0], coolColor[1], coolColor[2]);
    this.shaftProgram.setUniform3f('u_warmColor', warmColor[0], warmColor[1], warmColor[2]);
    this.shaftProgram.setUniform1f('u_intensity', intensity);
    this.shaftProgram.setUniform1f('u_time', timeSec);
    gl.bindVertexArray(this.shaftVao);
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
    gl.deleteVertexArray(this.shaftVao);
    gl.deleteBuffer(this.quadBuffer);
    this.skyProgram.dispose();
    this.layerProgram.dispose();
    this.solidProgram.dispose();
    this.shaftProgram.dispose();
  }
}
