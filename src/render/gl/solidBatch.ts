/**
 * Batched solid-colour rectangles.
 *
 * Every rect queued between {@link SolidBatch.begin} and {@link SolidBatch.flush} is drawn with a
 * single `drawElementsInstanced` call: a static unit quad (4 vertices, 6 indices) is stamped once
 * per instance, and per-instance attributes (`a_rect`, `a_color`) carry the position/size/colour.
 * The instance buffer is preallocated once at construction, so steady-state use allocates nothing.
 *
 * Coordinates are world-space and y-down, matching Canvas2D: `u_camera` is subtracted from the
 * rect position and the result is mapped to clip space with `y` flipped, so callers keep the same
 * mental model whether the frame ends up on a 2D or a WebGL2 canvas.
 */

import { Program } from './program';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_color;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec4 v_color;

void main() {
  vec2 worldPos = a_rect.xy + a_unit * a_rect.zw;
  vec2 screenPos = worldPos - u_camera;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
}
`;

/** Default instance capacity: enough headroom for a busy frame without growing mid-level. */
const DEFAULT_CAPACITY = 16384;

/** x, y, w, h, r, g, b, a per instance. */
const FLOATS_PER_INSTANCE = 8;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;

/** Two triangles covering the unit quad, indexed to avoid duplicating shared corners. */
const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Instanced solid-colour rect batch.
 *
 * Usage: `batch.begin(view, camera)`, any number of `batch.rect(...)` calls, then
 * `batch.flush()`. `rect()` flushes automatically (and transparently) if the instance buffer
 * fills up, so callers never need to worry about the capacity limit.
 */
export class SolidBatch {
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

    const rectLocation = this.program.attribLocation('a_rect');
    gl.enableVertexAttribArray(rectLocation);
    gl.vertexAttribPointer(rectLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(rectLocation, 1);

    const colorLocation = this.program.attribLocation('a_color');
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(
      colorLocation,
      4,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      4 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(colorLocation, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /** Start a new batch pass: sets the view/camera uniforms used by every rect until the next call. */
  begin(view: ViewSize, camera: CameraOffset): void {
    this.viewWidth = view.width;
    this.viewHeight = view.height;
    this.cameraX = camera.x;
    this.cameraY = camera.y;
    this.count = 0;
  }

  /** Queue an axis-aligned solid rect in world space. Colour channels are 0-1 floats. */
  rect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
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
    this.count += 1;
  }

  /** Submit every pending rect as one instanced draw call, then reset the queue. No-op if empty. */
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

  /** Discard any pending (un-flushed) rects without issuing a draw call. */
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
