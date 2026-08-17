/**
 * GPU-instanced, soft-edged particle batch.
 *
 * Replaces the flat-rect particle quads `GlWorldRenderer` used to draw through `SolidBatch` with a
 * dedicated instanced batch whose fragment shader applies a radial falloff, so sparks/dust/rings
 * read as soft blobs (or a soft annulus for `ring`) instead of hard-edged squares — closer to
 * Classic's stroked-circle `ring` look than the filled-square approximation the deferred pipeline
 * used before. One `drawElementsInstanced` call handles every queued particle regardless of count:
 * this shape/size of instanced draw comfortably budgets up to roughly 10k particles per frame on
 * integrated GPUs, well above `ParticleSystem`'s own pool size (512 — see `src/game/world.ts`), so
 * there is headroom for busier scenes without a second draw call or format change.
 *
 * Blending is the caller's responsibility, same convention as `SolidBatch`/`GBufferBatch`: `begin()`
 * only resets the instance queue and view/camera uniforms, so `GlWorldRenderer` can flush bright,
 * glow-like kinds additively and soft kinds through source-over blending without this batch needing
 * to know which is which (see `particleBlendGroup` and `drawParticles` there). This batch never
 * participates in the deferred lighting pass's G-buffer (no emissive write) — it draws forward,
 * after lighting, exactly where the ghosts/flame/particle forward pass already ran.
 */

import type { ParticleKind } from '../particles';
import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_color;
in float a_shape;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec2 v_local;
out vec4 v_color;
out float v_shape;

void main() {
  vec2 worldPos = a_rect.xy + a_unit * a_rect.zw;
  vec2 screenPos = worldPos - u_camera;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_local = a_unit;
  v_color = a_color;
  v_shape = a_shape;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_local;
in vec4 v_color;
in float v_shape;
out vec4 outColor;

void main() {
  vec2 c = v_local * 2.0 - 1.0;
  float dist = length(c);
  float alpha;
  if (v_shape > 0.5) {
    // Ring: a soft annulus around radius 0.7, matching Classic's stroked-circle ring particle.
    alpha = 1.0 - smoothstep(0.0, 0.55, abs(dist - 0.7));
  } else {
    // Blob: hotter soft core with a wider falloff so additive sparks read as glowing motes
    // (Dead Cells VFX), not hard discs.
    float core = 1.0 - smoothstep(0.0, 0.5, dist);
    float halo = 1.0 - smoothstep(0.15, 1.0, dist);
    alpha = max(core, halo * 0.65);
  }
  // Brighten the centre of additive-looking particles without changing the caller's RGB.
  float hot = 1.0 + (1.0 - smoothstep(0.0, 0.6, dist)) * 0.45;
  outColor = vec4(min(v_color.rgb * hot, vec3(1.0)), v_color.a * alpha);
}
`;

/** Comfortably above the "budget for 10k" target — see the module doc. */
const DEFAULT_CAPACITY = 10_000;

/** x, y, w, h, r, g, b, a, shape per instance. */
const FLOATS_PER_INSTANCE = 9;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;

const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

/** Which falloff shape a queued particle renders with — see the fragment shader above. */
export type ParticleShape = 'blob' | 'ring';

/** Maps a {@link ParticleShape} to the shader's `a_shape` attribute value. */
export function shapeValue(shape: ParticleShape): number {
  switch (shape) {
    case 'blob':
      return 0;
    case 'ring':
      return 1;
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unhandled particle shape: ${String(exhaustive)}`);
    }
  }
}

/** Which blend pass (see `GlWorldRenderer.drawParticles`) a given particle kind belongs in. */
export type ParticleBlendGroup = 'additive' | 'alpha';

/**
 * Bright, glow-like kinds (sparks flying off a stomp, jetpack exhaust) look better added on top of
 * the scene; solid-ish kinds (debris chunks, landing dust, the pickup sparkle, ring shockwaves)
 * look better blended normally so they do not wash out against bright backgrounds. Classic draws
 * every kind through plain alpha blending (`ParticleSystem.draw`'s default Canvas2D composite
 * mode), so this split is a deliberate Enhanced-only upgrade, not a correctness fix.
 */
export function particleBlendGroup(kind: ParticleKind): ParticleBlendGroup {
  switch (kind) {
    case 'spark':
    case 'exhaust':
      return 'additive';
    case 'debris':
    case 'dust':
    case 'pickup':
    case 'ring':
      return 'alpha';
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled particle kind in particleBlendGroup: ${String(exhaustive)}`);
    }
  }
}

/**
 * Instanced soft-edged particle batch. Usage mirrors `SolidBatch`: `begin(view, camera)`, any
 * number of `particle(...)` calls, then `flush()`. `particle()` flushes automatically (and
 * transparently) if the instance buffer fills up.
 */
export class ParticleBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
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

  constructor(gl: WebGL2RenderingContext, capacity: number = DEFAULT_CAPACITY) {
    this.gl = gl;
    this.capacity = capacity;
    this.instanceData = new Float32Array(capacity * FLOATS_PER_INSTANCE);
    this.program = new Program(gl, VERTEX_SHADER, FRAGMENT_SHADER);

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

    let byteOffset = 0;
    const rectLocation = this.program.attribLocation('a_rect');
    gl.enableVertexAttribArray(rectLocation);
    gl.vertexAttribPointer(rectLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, byteOffset);
    gl.vertexAttribDivisor(rectLocation, 1);
    byteOffset += 4 * Float32Array.BYTES_PER_ELEMENT;

    const colorLocation = this.program.attribLocation('a_color');
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, byteOffset);
    gl.vertexAttribDivisor(colorLocation, 1);
    byteOffset += 4 * Float32Array.BYTES_PER_ELEMENT;

    const shapeLocation = this.program.attribLocation('a_shape');
    gl.enableVertexAttribArray(shapeLocation);
    gl.vertexAttribPointer(shapeLocation, 1, gl.FLOAT, false, BYTES_PER_INSTANCE, byteOffset);
    gl.vertexAttribDivisor(shapeLocation, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  begin(view: ViewSize, camera: CameraOffset): void {
    this.viewWidth = view.width;
    this.viewHeight = view.height;
    this.cameraX = camera.x;
    this.cameraY = camera.y;
    this.count = 0;
  }

  /** Queue one soft-edged particle quad in world space. Colour/alpha channels are 0-1 floats. */
  particle(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
    shape: ParticleShape = 'blob',
  ): void {
    if (this.count >= this.capacity) {
      this.flush();
    }
    const offset = this.count * FLOATS_PER_INSTANCE;
    this.instanceData[offset] = x;
    this.instanceData[offset + 1] = y;
    this.instanceData[offset + 2] = w;
    this.instanceData[offset + 3] = h;
    this.instanceData[offset + 4] = r;
    this.instanceData[offset + 5] = g;
    this.instanceData[offset + 6] = b;
    this.instanceData[offset + 7] = a;
    this.instanceData[offset + 8] = shapeValue(shape);
    this.count += 1;
  }

  /** Submit every pending particle as one instanced draw call, then reset the queue. */
  flush(): void {
    if (this.count === 0) return;
    const { gl } = this;

    this.program.use();
    this.program.setUniform2f('u_view', this.viewWidth, this.viewHeight);
    this.program.setUniform2f('u_camera', this.cameraX, this.cameraY);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.count * FLOATS_PER_INSTANCE);
    gl.drawElementsInstanced(gl.TRIANGLES, UNIT_QUAD_INDICES.length, gl.UNSIGNED_SHORT, 0, this.count);
    gl.bindVertexArray(null);

    this.count = 0;
  }

  clear(): void {
    this.count = 0;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.unitQuadBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    this.program.dispose();
  }
}
