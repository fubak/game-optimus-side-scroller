/**
 * Batched instanced tile quads, textured from a material atlas and written straight into the
 * deferred G-buffer (albedo, normal, material, emissive) via multiple render targets.
 *
 * Structurally this is {@link SolidBatch} with two changes: each instance carries an atlas UV rect
 * instead of a flat colour, and the fragment shader writes four `layout(location=N)` outputs
 * instead of one — WebGL2's MRT mechanism, bound once per frame by whichever {@link RenderTarget}
 * is current when {@link TileBatch.flush} runs.
 */

import type { MaterialTextureSet } from './materialTextures';
import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_uv;
in float a_emissive;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec2 v_uv;
out float v_emissive;

void main() {
  vec2 worldPos = a_rect.xy + a_unit * a_rect.zw;
  vec2 screenPos = worldPos - u_camera;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_unit);
  v_emissive = a_emissive;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
in float v_emissive;

uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_params;

layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outMaterial;
layout(location = 3) out vec4 outEmissive;

void main() {
  vec4 albedo = texture(u_albedo, v_uv);
  vec3 normalPacked = texture(u_normal, v_uv).rgb;
  vec4 material = texture(u_params, v_uv);
  // Alpha carries through as G-buffer coverage: materials with intentional holes (grating,
  // catwalk) let the background show through instead of painting a solid tile over them.
  outAlbedo = vec4(albedo.rgb, albedo.a);
  outNormal = vec4(normalPacked, 1.0);
  outMaterial = material;
  outEmissive = vec4(albedo.rgb * v_emissive, 1.0);
}
`;

const DEFAULT_CAPACITY = 4096;

/** x, y, w, h, u0, v0, u1, v1, emissive per instance. */
const FLOATS_PER_INSTANCE = 9;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;

const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

/** Atlas rect expressed as UVs (0..1), not pixels — see {@link TileBatch.tile}. */
export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export class TileBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly textures: MaterialTextureSet;
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

  constructor(gl: WebGL2RenderingContext, textures: MaterialTextureSet, capacity: number = DEFAULT_CAPACITY) {
    this.gl = gl;
    this.textures = textures;
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

    const uvLocation = this.program.attribLocation('a_uv');
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(uvLocation, 1);

    const emissiveLocation = this.program.attribLocation('a_emissive');
    gl.enableVertexAttribArray(emissiveLocation);
    gl.vertexAttribPointer(
      emissiveLocation,
      1,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      8 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(emissiveLocation, 1);

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

  /** Queue one textured tile quad in world space, sampling `uv` from the shared material atlas. */
  tile(x: number, y: number, w: number, h: number, uv: UvRect, emissive: number): void {
    if (this.count >= this.capacity) {
      this.flush();
    }
    const offset = this.count * FLOATS_PER_INSTANCE;
    this.instanceData[offset] = x;
    this.instanceData[offset + 1] = y;
    this.instanceData[offset + 2] = w;
    this.instanceData[offset + 3] = h;
    this.instanceData[offset + 4] = uv.u0;
    this.instanceData[offset + 5] = uv.v0;
    this.instanceData[offset + 6] = uv.u1;
    this.instanceData[offset + 7] = uv.v1;
    this.instanceData[offset + 8] = emissive;
    this.count += 1;
  }

  flush(): void {
    if (this.count === 0) return;
    const { gl } = this;

    this.program.use();
    this.program.setUniform2f('u_view', this.viewWidth, this.viewHeight);
    this.program.setUniform2f('u_camera', this.cameraX, this.cameraY);
    this.program.setUniform1i('u_albedo', 0);
    this.program.setUniform1i('u_normal', 1);
    this.program.setUniform1i('u_params', 2);
    this.textures.albedo.bind(0);
    this.textures.normal.bind(1);
    this.textures.params.bind(2);

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
