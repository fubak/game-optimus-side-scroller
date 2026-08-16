/**
 * Instanced quad renderer.
 *
 * Particles are the one thing in the game that genuinely needs thousands of
 * draws per frame. The sprite batcher can technically do it — it merges quads
 * into one draw call — but it re-uploads four full vertices per quad, which
 * means 128 bytes of bus traffic for every particle, every frame.
 *
 * Instancing uploads one 24-byte record per particle against a static
 * four-vertex quad, cutting the per-particle traffic by more than five times
 * and moving the corner expansion onto the GPU where it belongs. That is the
 * difference between a few hundred motes and the several thousand the
 * atmosphere actually needs.
 *
 * ## Instance layout (24 bytes)
 *
 * | offset | attribute | type        | meaning                    |
 * |--------|-----------|-------------|----------------------------|
 * | 0      | iPos      | 3 x float32 | x, y in metres; z = depth  |
 * | 12     | iSize     | 1 x float32 | half-extent in metres      |
 * | 16     | iRotation | 1 x float32 | radians                    |
 * | 20     | iColor    | 4 x unorm8  | premultiplied tint         |
 */

import { Device, GfxError } from './device.ts';
import { Program } from './program.ts';

export const INSTANCE_STRIDE_BYTES = 24;
const FLOATS_PER_INSTANCE = INSTANCE_STRIDE_BYTES / 4;

/** Attribute locations, matched by `layout(location = N)` in the shader. */
export const INSTANCE_ATTRIB = {
  corner: 0,
  position: 1,
  size: 2,
  rotation: 3,
  color: 4,
} as const;

export class InstancedQuads {
  private readonly data: ArrayBuffer;
  private readonly floats: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly vao: WebGLVertexArrayObject;
  private readonly cornerBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;

  private count = 0;

  constructor(
    private readonly device: Device,
    readonly capacity: number,
  ) {
    const gl = device.gl;

    this.data = new ArrayBuffer(capacity * INSTANCE_STRIDE_BYTES);
    this.floats = new Float32Array(this.data);
    this.bytes = new Uint8Array(this.data);

    const vao = gl.createVertexArray();
    const cornerBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    if (!vao || !cornerBuffer || !instanceBuffer) {
      throw new GfxError('Could not create instanced quad buffers');
    }
    this.vao = vao;
    this.cornerBuffer = cornerBuffer;
    this.instanceBuffer = instanceBuffer;

    gl.bindVertexArray(vao);

    // Static unit quad, expanded per instance in the vertex shader.
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(INSTANCE_ATTRIB.corner);
    gl.vertexAttribPointer(INSTANCE_ATTRIB.corner, 2, gl.FLOAT, false, 8, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(INSTANCE_ATTRIB.position);
    gl.vertexAttribPointer(INSTANCE_ATTRIB.position, 3, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 0);
    gl.vertexAttribDivisor(INSTANCE_ATTRIB.position, 1);

    gl.enableVertexAttribArray(INSTANCE_ATTRIB.size);
    gl.vertexAttribPointer(INSTANCE_ATTRIB.size, 1, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 12);
    gl.vertexAttribDivisor(INSTANCE_ATTRIB.size, 1);

    gl.enableVertexAttribArray(INSTANCE_ATTRIB.rotation);
    gl.vertexAttribPointer(INSTANCE_ATTRIB.rotation, 1, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 16);
    gl.vertexAttribDivisor(INSTANCE_ATTRIB.rotation, 1);

    gl.enableVertexAttribArray(INSTANCE_ATTRIB.color);
    gl.vertexAttribPointer(
      INSTANCE_ATTRIB.color,
      4,
      gl.UNSIGNED_BYTE,
      true,
      INSTANCE_STRIDE_BYTES,
      20,
    );
    gl.vertexAttribDivisor(INSTANCE_ATTRIB.color, 1);

    gl.bindVertexArray(null);
    device.invalidateStateCache();
  }

  clear(): void {
    this.count = 0;
  }

  /** Queue one instance. Silently drops past capacity rather than growing. */
  push(x: number, y: number, depth: number, size: number, rotation: number, color: number): void {
    if (this.count >= this.capacity) return;
    const base = this.count * FLOATS_PER_INSTANCE;
    this.floats[base] = x;
    this.floats[base + 1] = y;
    this.floats[base + 2] = depth;
    this.floats[base + 3] = size;
    this.floats[base + 4] = rotation;

    const byteBase = base * 4;
    this.bytes[byteBase + 20] = (color >>> 24) & 0xff;
    this.bytes[byteBase + 21] = (color >>> 16) & 0xff;
    this.bytes[byteBase + 22] = (color >>> 8) & 0xff;
    this.bytes[byteBase + 23] = color & 0xff;

    this.count++;
  }

  /** Upload and draw everything queued. */
  flush(program: Program): void {
    if (this.count === 0) return;
    const gl = this.device.gl;

    this.device.bindVAO(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.bytes.subarray(0, this.count * INSTANCE_STRIDE_BYTES),
    );

    program.use();
    this.device.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
  }

  get queued(): number {
    return this.count;
  }

  dispose(): void {
    const gl = this.device.gl;
    gl.deleteBuffer(this.cornerBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
  }
}
