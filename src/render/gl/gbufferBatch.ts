/**
 * Batched instanced solid-colour quads written into the deferred G-buffer.
 *
 * Used for every entity (player, enemies, pickups, projectiles) instead of the textured
 * {@link TileBatch}: no atlas UVs, just a flat colour, an optional emissive tint, and two material
 * scalars (roughness, metallic — AO is assumed 1 for entities, since they have no baked crevices).
 * The one thing this batch does that {@link SolidBatch} does not is fabricate a normal: real
 * per-entity normal maps do not exist in this project (there are no image assets at all), so the
 * fragment shader derives a cheap "pillow" bevel from each fragment's position within its quad —
 * enough for a directional key light to read as a rounded surface instead of a flat cutout.
 */

import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_color;
in vec3 a_emissive;
in vec2 a_material;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec2 v_local;
out vec4 v_color;
out vec3 v_emissive;
out vec2 v_material;

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
  v_emissive = a_emissive;
  v_material = a_material;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_local;
in vec4 v_color;
in vec3 v_emissive;
in vec2 v_material;

layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outMaterial;
layout(location = 3) out vec4 outEmissive;

void main() {
  vec2 c = v_local * 2.0 - 1.0;
  float r2 = min(dot(c, c), 1.0);
  float nz = sqrt(max(0.0, 1.0 - r2 * 0.7));
  vec3 normal = normalize(vec3(c * 0.55, nz));

  outAlbedo = vec4(v_color.rgb, v_color.a);
  outNormal = vec4(normal * 0.5 + 0.5, 1.0);
  outMaterial = vec4(v_material.x, 1.0, v_material.y, 1.0);
  outEmissive = vec4(v_emissive, 1.0);
}
`;

/** Default instance capacity: comfortably more than one frame's worth of entity quads. */
const DEFAULT_CAPACITY = 2048;

/** x, y, w, h, r, g, b, a, er, eg, eb, roughness, metallic per instance. */
const FLOATS_PER_INSTANCE = 13;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;

const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

/** Per-quad material/emissive description, kept as an object so call sites read clearly. */
export interface GBufferQuadStyle {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
  readonly emissiveR?: number;
  readonly emissiveG?: number;
  readonly emissiveB?: number;
  readonly roughness?: number;
  readonly metallic?: number;
}

export class GBufferBatch {
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

    const emissiveLocation = this.program.attribLocation('a_emissive');
    gl.enableVertexAttribArray(emissiveLocation);
    gl.vertexAttribPointer(emissiveLocation, 3, gl.FLOAT, false, BYTES_PER_INSTANCE, byteOffset);
    gl.vertexAttribDivisor(emissiveLocation, 1);
    byteOffset += 3 * Float32Array.BYTES_PER_ELEMENT;

    const materialLocation = this.program.attribLocation('a_material');
    gl.enableVertexAttribArray(materialLocation);
    gl.vertexAttribPointer(materialLocation, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, byteOffset);
    gl.vertexAttribDivisor(materialLocation, 1);

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

  /** Queue one entity quad in world space. */
  rect(x: number, y: number, w: number, h: number, style: GBufferQuadStyle): void {
    if (this.count >= this.capacity) {
      this.flush();
    }
    const offset = this.count * FLOATS_PER_INSTANCE;
    this.instanceData[offset] = x;
    this.instanceData[offset + 1] = y;
    this.instanceData[offset + 2] = w;
    this.instanceData[offset + 3] = h;
    this.instanceData[offset + 4] = style.r;
    this.instanceData[offset + 5] = style.g;
    this.instanceData[offset + 6] = style.b;
    this.instanceData[offset + 7] = style.a ?? 1;
    this.instanceData[offset + 8] = style.emissiveR ?? 0;
    this.instanceData[offset + 9] = style.emissiveG ?? 0;
    this.instanceData[offset + 10] = style.emissiveB ?? 0;
    this.instanceData[offset + 11] = style.roughness ?? 0.55;
    this.instanceData[offset + 12] = style.metallic ?? 0.25;
    this.count += 1;
  }

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
