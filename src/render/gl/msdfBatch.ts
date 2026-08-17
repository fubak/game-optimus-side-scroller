/**
 * Batched instanced MSDF text quads.
 *
 * Same shape as `SolidBatch`: every glyph queued between {@link MsdfBatch.begin} and
 * {@link MsdfBatch.flush} is drawn with a single `drawElementsInstanced` call over a static unit
 * quad, with per-instance attributes carrying the destination rect, atlas UV rect, and tint. The
 * fragment shader takes the median of the atlas's three distance channels (the MSDF reconstruction
 * trick — see `msdfFont.ts`) and turns it into a soft, `fwidth`-scaled edge, so glyphs stay smooth
 * at any scale instead of needing a mip chain or a blur pass.
 *
 * Standalone for now: nothing in the live renderer constructs this yet (Stage 1's HUD/menus still
 * render through Canvas2D `drawText`). It exists so the GL UI work in a later stage has a text
 * primitive to build on without having to design the shader/atlas plumbing from scratch.
 */

import type { MsdfAtlasData, MsdfFontMetrics, MsdfGlyphRect } from '../msdfFont';
import { GLYPH_WIDTH, resolveGlyphCharacter } from '../text';
import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';
import { Filter, TexFormat, Texture, Wrap } from './texture';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_uvRect;
in vec4 a_color;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec2 v_uv;
out vec4 v_color;

void main() {
  vec2 worldPos = a_rect.xy + a_unit * a_rect.zw;
  vec2 screenPos = worldPos - u_camera;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = mix(a_uvRect.xy, a_uvRect.zw, a_unit);
  v_color = a_color;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_color;

uniform sampler2D u_atlas;

out vec4 outColor;

// The MSDF reconstruction: three per-metric distance channels agree away from corners and the
// median rejects whichever one is the outlier near them, approximating a single robust SDF.
float median(float a, float b, float c) {
  return max(min(a, b), min(max(a, b), c));
}

void main() {
  vec3 sample3 = texture(u_atlas, v_uv).rgb;
  float signedDistance = median(sample3.r, sample3.g, sample3.b) - 0.5;
  // fwidth() gives the on-screen derivative of the signed distance, so the anti-alias ramp is
  // always ~1 pixel wide regardless of how much the glyph quad is scaled.
  float edgeWidth = max(fwidth(signedDistance), 1e-5);
  float alpha = smoothstep(-edgeWidth, edgeWidth, signedDistance);
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

/** Default instance capacity: a full screen of HUD/menu text without growing mid-frame. */
const DEFAULT_CAPACITY = 4096;

/** x, y, w, h, u0, v0, u1, v1, r, g, b, a per instance. */
const FLOATS_PER_INSTANCE = 12;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;

const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Instanced MSDF glyph batch.
 *
 * Owns one `Texture` uploaded from {@link MsdfAtlasData.pixels} — no `<canvas>`/DOM dependency, so
 * this can be built directly from `buildMsdfAtlasData()`. Usage mirrors `SolidBatch`: `begin`, any
 * number of `glyph()`/`text()` calls, then `flush()`. Callers must enable blending themselves
 * (`gl.enable(gl.BLEND)` with a standard alpha blend function) since, unlike opaque solid rects,
 * glyph edges rely on it.
 */
export class MsdfBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly atlasTexture: Texture;
  private readonly metrics: MsdfFontMetrics;
  private readonly glyphs: ReadonlyMap<string, MsdfGlyphRect>;
  private readonly atlasWidth: number;
  private readonly atlasHeight: number;

  private readonly vao: WebGLVertexArrayObject;
  private readonly unitQuadBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly instanceData: Float32Array;
  private readonly capacity: number;

  private count = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private cameraX = 0;
  private cameraY = 0;

  constructor(gl: WebGL2RenderingContext, atlas: MsdfAtlasData, capacity: number = DEFAULT_CAPACITY) {
    this.gl = gl;
    this.capacity = capacity;
    this.metrics = atlas.metrics;
    this.glyphs = atlas.glyphs;
    this.atlasWidth = atlas.width;
    this.atlasHeight = atlas.height;
    this.instanceData = new Float32Array(capacity * FLOATS_PER_INSTANCE);
    this.program = new Program(gl, VERTEX_SHADER, FRAGMENT_SHADER);

    this.atlasTexture = new Texture(gl, TexFormat.RGBA8, { filter: Filter.Linear, wrap: Wrap.Clamp });
    this.atlasTexture.uploadRGBA(atlas.pixels, atlas.width, atlas.height);

    this.vao = gl.createVertexArray();
    this.unitQuadBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();

    this.setupVertexState();
  }

  private setupVertexState(): void {
    const { gl } = this;
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD_VERTICES, gl.STATIC_DRAW);
    const unitLocation = this.program.attribLocation('a_unit');
    gl.enableVertexAttribArray(unitLocation);
    gl.vertexAttribPointer(unitLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, UNIT_QUAD_INDICES, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    const rectLocation = this.program.attribLocation('a_rect');
    gl.enableVertexAttribArray(rectLocation);
    gl.vertexAttribPointer(rectLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(rectLocation, 1);

    const uvLocation = this.program.attribLocation('a_uvRect');
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(uvLocation, 1);

    const colorLocation = this.program.attribLocation('a_color');
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 8 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(colorLocation, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /** Start a new batch pass: sets the view/camera uniforms used by every glyph until the next call. */
  begin(view: ViewSize, camera: CameraOffset): void {
    this.viewWidth = view.width;
    this.viewHeight = view.height;
    this.cameraX = camera.x;
    this.cameraY = camera.y;
    this.count = 0;
  }

  /** Queue one glyph quad in world space, with an explicit destination rect and atlas UV rect. */
  glyph(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: RGBA,
  ): void {
    if (this.count >= this.capacity) {
      this.flush();
    }
    const offset = this.count * FLOATS_PER_INSTANCE;
    this.instanceData[offset] = x;
    this.instanceData[offset + 1] = y;
    this.instanceData[offset + 2] = width;
    this.instanceData[offset + 3] = height;
    this.instanceData[offset + 4] = u0;
    this.instanceData[offset + 5] = v0;
    this.instanceData[offset + 6] = u1;
    this.instanceData[offset + 7] = v1;
    this.instanceData[offset + 8] = color.r;
    this.instanceData[offset + 9] = color.g;
    this.instanceData[offset + 10] = color.b;
    this.instanceData[offset + 11] = color.a;
    this.count += 1;
  }

  /**
   * Queue a whole string, matching `measureText`/`drawText`'s left-to-right advance so text laid
   * out with the bitmap font and text laid out here land on the same grid. `scale` is an integer
   * pixel multiplier of the un-padded 5×7 glyph box, exactly like `TextOptions.scale`.
   */
  text(value: string, x: number, y: number, scale: number, tracking: number, color: RGBA): void {
    let cursorX = x;
    for (const character of value) {
      const key = resolveGlyphCharacter(character);
      const rect = this.glyphs.get(key) ?? this.glyphs.get('?');
      if (rect !== undefined) {
        const destWidth = this.metrics.glyphWidth * scale;
        const destHeight = this.metrics.glyphHeight * scale;
        const glyphX = rect.x + rect.padPx;
        const glyphY = rect.y + rect.padPx;
        const glyphWidthPx = rect.width - rect.padPx * 2;
        const glyphHeightPx = rect.height - rect.padPx * 2;
        const u0 = glyphX / this.atlasWidth;
        const v0 = glyphY / this.atlasHeight;
        const u1 = (glyphX + glyphWidthPx) / this.atlasWidth;
        const v1 = (glyphY + glyphHeightPx) / this.atlasHeight;
        this.glyph(cursorX, y, destWidth, destHeight, u0, v0, u1, v1, color);
      }
      cursorX += (GLYPH_WIDTH + tracking) * scale;
    }
  }

  /** Submit every pending glyph as one instanced draw call, then reset the queue. No-op if empty. */
  flush(): void {
    if (this.count === 0) return;
    const { gl } = this;

    this.program.use();
    this.program.setUniform2f('u_view', this.viewWidth, this.viewHeight);
    this.program.setUniform2f('u_camera', this.cameraX, this.cameraY);
    this.program.setUniform1i('u_atlas', 0);
    this.atlasTexture.bind(0);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.count * FLOATS_PER_INSTANCE);
    gl.drawElementsInstanced(gl.TRIANGLES, UNIT_QUAD_INDICES.length, gl.UNSIGNED_SHORT, 0, this.count);
    gl.bindVertexArray(null);

    this.count = 0;
  }

  /** Discard any pending (un-flushed) glyphs without issuing a draw call. */
  clear(): void {
    this.count = 0;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.unitQuadBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    this.atlasTexture.dispose();
    this.program.dispose();
  }
}
