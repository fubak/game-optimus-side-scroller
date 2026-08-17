/**
 * Instanced textured character quads written into the deferred G-buffer.
 *
 * Samples a procedural sprite atlas (albedo + emissive). Soft alpha from the baker becomes
 * G-buffer coverage so silhouettes composite cleanly over the background.
 */

import type { CharacterTextureSet } from './characterTextures';
import { Program } from './program';
import type { CameraOffset, ViewSize } from './solidBatch';
import type { UvRect } from './tileBatch';

const VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
in vec4 a_rect;
in vec4 a_uv;

uniform vec2 u_view;
uniform vec2 u_camera;

out vec2 v_uv;

void main() {
  vec2 worldPos = a_rect.xy + a_unit * a_rect.zw;
  vec2 screenPos = worldPos - u_camera;
  vec2 clip = vec2(
    (screenPos.x / u_view.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / u_view.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_unit);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
uniform sampler2D u_albedo;
uniform sampler2D u_emissive;

layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outMaterial;
layout(location = 3) out vec4 outEmissive;

void main() {
  vec4 albedo = texture(u_albedo, v_uv);
  if (albedo.a < 0.04) discard;
  vec3 emit = texture(u_emissive, v_uv).rgb;
  // Soft pillow normal so key light still sculpts the sprite silhouette.
  vec2 c = v_uv * 2.0 - 1.0;
  float r2 = min(dot(c, c), 1.0);
  float nz = sqrt(max(0.0, 1.0 - r2 * 0.55));
  vec3 normal = normalize(vec3(c * 0.35, nz));
  outAlbedo = albedo;
  outNormal = vec4(normal * 0.5 + 0.5, 1.0);
  outMaterial = vec4(0.45, 1.0, 0.35, 1.0);
  outEmissive = vec4(emit, 1.0);
}
`;

const DEFAULT_CAPACITY = 256;
const FLOATS_PER_INSTANCE = 8;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT;
const UNIT_QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIT_QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export class SpriteGBufferBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: Program;
  private readonly textures: CharacterTextureSet;
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

  constructor(gl: WebGL2RenderingContext, textures: CharacterTextureSet, capacity = DEFAULT_CAPACITY) {
    this.gl = gl;
    this.textures = textures;
    this.capacity = capacity;
    this.program = new Program(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.instanceData = new Float32Array(capacity * FLOATS_PER_INSTANCE);

    this.vao = gl.createVertexArray();
    this.unitQuadBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD_VERTICES, gl.STATIC_DRAW);
    const unitLoc = this.program.attribLocation('a_unit');
    gl.enableVertexAttribArray(unitLoc);
    gl.vertexAttribPointer(unitLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, UNIT_QUAD_INDICES, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    let offset = 0;
    const rectLoc = this.program.attribLocation('a_rect');
    gl.enableVertexAttribArray(rectLoc);
    gl.vertexAttribPointer(rectLoc, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, offset);
    gl.vertexAttribDivisor(rectLoc, 1);
    offset += 16;
    const uvLoc = this.program.attribLocation('a_uv');
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, offset);
    gl.vertexAttribDivisor(uvLoc, 1);
    gl.bindVertexArray(null);
  }

  begin(view: ViewSize, camera: CameraOffset): void {
    this.count = 0;
    this.viewWidth = view.width;
    this.viewHeight = view.height;
    this.cameraX = camera.x;
    this.cameraY = camera.y;
  }

  sprite(x: number, y: number, w: number, h: number, uv: UvRect): void {
    if (this.count >= this.capacity) return;
    const offset = this.count * FLOATS_PER_INSTANCE;
    this.instanceData[offset] = x;
    this.instanceData[offset + 1] = y;
    this.instanceData[offset + 2] = w;
    this.instanceData[offset + 3] = h;
    this.instanceData[offset + 4] = uv.u0;
    this.instanceData[offset + 5] = uv.v0;
    this.instanceData[offset + 6] = uv.u1;
    this.instanceData[offset + 7] = uv.v1;
    this.count += 1;
  }

  flush(): void {
    if (this.count === 0) return;
    const { gl } = this;
    this.program.use();
    this.program.setUniform2f('u_view', this.viewWidth, this.viewHeight);
    this.program.setUniform2f('u_camera', this.cameraX, this.cameraY);
    this.textures.albedo.bind(0);
    this.textures.emissive.bind(1);
    this.program.setUniform1i('u_albedo', 0);
    this.program.setUniform1i('u_emissive', 1);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, this.count * FLOATS_PER_INSTANCE));
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.count);
    gl.bindVertexArray(null);
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
