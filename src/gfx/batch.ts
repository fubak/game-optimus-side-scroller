/**
 * Batched sprite renderer.
 *
 * Everything visible in the game — parallax layers, tiles, props, the character
 * rig's individual panels, particles, UI — is ultimately a textured quad. Issued
 * one at a time that would be tens of thousands of draw calls per frame. This
 * batcher accumulates quads into a single streaming vertex buffer and flushes
 * only when something that cannot change mid-draw does change: the texture set,
 * or the blend mode.
 *
 * ## Vertex layout (32 bytes, deliberately a power of two)
 *
 * | offset | attribute | type        | meaning                                  |
 * |--------|-----------|-------------|------------------------------------------|
 * | 0      | aPos      | 3 x float32 | x, y in metres; z is parallax depth      |
 * | 12     | aUV       | 2 x float32 | atlas coordinates                        |
 * | 20     | aColor    | 4 x unorm8  | tint, premultiplied                      |
 * | 24     | aMaterial | 4 x unorm8  | emissive, roughness, metallic, translucency |
 * | 28     | aRotation | 1 x float32 | sprite rotation, radians                 |
 *
 * Rotation is passed per-vertex rather than baked into the positions on the CPU
 * because the fragment shader needs it anyway: a rotated sprite's normal map
 * must have its normals rotated to match, or its lighting will stay stubbornly
 * fixed while the sprite spins.
 */

import { Device, GfxError, BlendMode } from './device.ts';
import { Program } from './program.ts';
import type { Texture } from './texture.ts';

export const VERTEX_STRIDE_BYTES = 32;
const FLOATS_PER_VERTEX = VERTEX_STRIDE_BYTES / 4;
const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

/** Attribute locations, matched by `layout(location = N)` in the shader. */
export const ATTRIB = {
  position: 0,
  uv: 1,
  color: 2,
  material: 3,
  rotation: 4,
} as const;

export interface SpriteMaterial {
  /** Extra emissive intensity on top of the atlas's emissive channel. */
  emissive: number;
  roughness: number;
  metallic: number;
  /** Light bleed for translucent surfaces such as membranes and crystal. */
  translucency: number;
}

export const DEFAULT_MATERIAL: SpriteMaterial = {
  emissive: 0,
  roughness: 0.65,
  metallic: 0.9,
  translucency: 0,
};

/** A set of atlas pages sharing one UV layout. */
export interface TextureSet {
  albedo: Texture;
  /** RG = normal xy, B = height, A = ambient occlusion. */
  normal: Texture;
  /** R = roughness, G = metallic, B = emissive mask, A = translucency. */
  material: Texture;
}

export class SpriteBatch {
  private readonly vertexData: ArrayBuffer;
  private readonly floats: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;

  private quadCount = 0;
  private currentTextures: TextureSet | null = null;
  private currentBlend: BlendMode = BlendMode.Premultiplied;
  private program: Program | null = null;
  private drawing = false;

  /** Flushes issued this frame, for diagnostics. Ideally this stays small. */
  flushCount = 0;

  constructor(
    private readonly device: Device,
    readonly maxQuads = 16384,
  ) {
    const gl = device.gl;

    this.vertexData = new ArrayBuffer(maxQuads * VERTICES_PER_QUAD * VERTEX_STRIDE_BYTES);
    this.floats = new Float32Array(this.vertexData);
    this.bytes = new Uint8Array(this.vertexData);

    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!vbo || !ibo || !vao) throw new GfxError('Could not create sprite batch buffers');
    this.vbo = vbo;
    this.ibo = ibo;
    this.vao = vao;

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(ATTRIB.position);
    gl.vertexAttribPointer(ATTRIB.position, 3, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 0);

    gl.enableVertexAttribArray(ATTRIB.uv);
    gl.vertexAttribPointer(ATTRIB.uv, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 12);

    gl.enableVertexAttribArray(ATTRIB.color);
    gl.vertexAttribPointer(ATTRIB.color, 4, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE_BYTES, 20);

    gl.enableVertexAttribArray(ATTRIB.material);
    gl.vertexAttribPointer(ATTRIB.material, 4, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE_BYTES, 24);

    gl.enableVertexAttribArray(ATTRIB.rotation);
    gl.vertexAttribPointer(ATTRIB.rotation, 1, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 28);

    // The index pattern never changes, so upload it once and forget about it.
    const indices = new Uint16Array(maxQuads * INDICES_PER_QUAD);
    for (let i = 0, v = 0; i < indices.length; i += INDICES_PER_QUAD, v += VERTICES_PER_QUAD) {
      indices[i] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = v + 2;
      indices[i + 3] = v;
      indices[i + 4] = v + 2;
      indices[i + 5] = v + 3;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    device.invalidateStateCache();
  }

  /** Begin accumulating. `program` stays bound for the whole batch. */
  begin(program: Program, blend: BlendMode = BlendMode.Premultiplied): void {
    if (this.drawing) throw new GfxError('SpriteBatch.begin called while already drawing');
    this.drawing = true;
    this.program = program;
    this.currentBlend = blend;
    this.currentTextures = null;
    this.quadCount = 0;
    this.flushCount = 0;
    program.use();
    this.device.setBlend(blend);
  }

  /**
   * Switch texture sets, flushing whatever is queued first.
   *
   * Sorting draws so that this is called as rarely as possible is the single
   * biggest lever on draw-call count, which is why the scene layer sorts by
   * material before submitting.
   */
  setTextures(textures: TextureSet): void {
    if (this.currentTextures === textures) return;
    this.flush();
    this.currentTextures = textures;
  }

  setBlend(blend: BlendMode): void {
    if (this.currentBlend === blend) return;
    this.flush();
    this.currentBlend = blend;
    this.device.setBlend(blend);
  }

  /**
   * Queue an axis-aligned sprite.
   *
   * All coordinates are in metres, with the origin at the sprite's centre.
   */
  draw(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    depth: number,
    color: number,
    material: number,
    rotation = 0,
  ): void {
    if (this.quadCount >= this.maxQuads) this.flush();

    const hw = width / 2;
    const hh = height / 2;

    let x0 = -hw;
    let y0 = -hh;
    let x1 = hw;
    let y1 = -hh;
    let x2 = hw;
    let y2 = hh;
    let x3 = -hw;
    let y3 = hh;

    if (rotation !== 0) {
      const c = Math.cos(rotation);
      const s = Math.sin(rotation);
      const rx0 = x0 * c - y0 * s;
      const ry0 = x0 * s + y0 * c;
      const rx1 = x1 * c - y1 * s;
      const ry1 = x1 * s + y1 * c;
      const rx2 = x2 * c - y2 * s;
      const ry2 = x2 * s + y2 * c;
      const rx3 = x3 * c - y3 * s;
      const ry3 = x3 * s + y3 * c;
      x0 = rx0;
      y0 = ry0;
      x1 = rx1;
      y1 = ry1;
      x2 = rx2;
      y2 = ry2;
      x3 = rx3;
      y3 = ry3;
    }

    this.pushVertex(x + x0, y + y0, depth, u0, v0, color, material, rotation);
    this.pushVertex(x + x1, y + y1, depth, u1, v0, color, material, rotation);
    this.pushVertex(x + x2, y + y2, depth, u1, v1, color, material, rotation);
    this.pushVertex(x + x3, y + y3, depth, u0, v1, color, material, rotation);
    this.quadCount++;
  }

  /**
   * Queue a quad from four explicit corners.
   *
   * Needed for anything that is not a rotated rectangle: trail ribbons, skewed
   * parallax planes, and the character rig's panels, which stretch between two
   * bone positions and so are genuinely arbitrary quadrilaterals.
   */
  drawQuad(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    depth: number,
    color: number,
    material: number,
    rotation = 0,
  ): void {
    if (this.quadCount >= this.maxQuads) this.flush();
    this.pushVertex(ax, ay, depth, u0, v0, color, material, rotation);
    this.pushVertex(bx, by, depth, u1, v0, color, material, rotation);
    this.pushVertex(cx, cy, depth, u1, v1, color, material, rotation);
    this.pushVertex(dx, dy, depth, u0, v1, color, material, rotation);
    this.quadCount++;
  }

  private pushVertex(
    x: number,
    y: number,
    depth: number,
    u: number,
    v: number,
    color: number,
    material: number,
    rotation: number,
  ): void {
    const base = (this.quadCount * VERTICES_PER_QUAD + this.vertexInQuad) * FLOATS_PER_VERTEX;
    const floats = this.floats;

    floats[base] = x;
    floats[base + 1] = y;
    floats[base + 2] = depth;
    floats[base + 3] = u;
    floats[base + 4] = v;

    // Colour and material are packed bytes sharing the buffer with the floats,
    // so write them through the byte view at the matching offset.
    const byteBase = base * 4;
    this.bytes[byteBase + 20] = (color >>> 24) & 0xff;
    this.bytes[byteBase + 21] = (color >>> 16) & 0xff;
    this.bytes[byteBase + 22] = (color >>> 8) & 0xff;
    this.bytes[byteBase + 23] = color & 0xff;
    this.bytes[byteBase + 24] = (material >>> 24) & 0xff;
    this.bytes[byteBase + 25] = (material >>> 16) & 0xff;
    this.bytes[byteBase + 26] = (material >>> 8) & 0xff;
    this.bytes[byteBase + 27] = material & 0xff;

    floats[base + 7] = rotation;

    this.vertexInQuad = (this.vertexInQuad + 1) % VERTICES_PER_QUAD;
  }

  private vertexInQuad = 0;

  /** Upload and draw everything queued so far. */
  flush(): void {
    if (this.quadCount === 0 || !this.program) return;
    const gl = this.device.gl;
    const textures = this.currentTextures;
    if (!textures) {
      // Nothing to sample from; drop the queue rather than drawing garbage.
      this.quadCount = 0;
      this.vertexInQuad = 0;
      return;
    }

    this.device.bindVAO(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    // A sub-range upload avoids re-sending the whole (large) buffer when only a
    // handful of quads are queued.
    const byteLength = this.quadCount * VERTICES_PER_QUAD * VERTEX_STRIDE_BYTES;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.bytes.subarray(0, byteLength));

    this.program.setTexture('uAlbedo', 0, textures.albedo.handle);
    this.program.setTexture('uNormal', 1, textures.normal.handle);
    this.program.setTexture('uMaterial', 2, textures.material.handle);

    this.device.drawElements(
      gl.TRIANGLES,
      this.quadCount * INDICES_PER_QUAD,
      gl.UNSIGNED_SHORT,
      0,
    );

    this.quadCount = 0;
    this.vertexInQuad = 0;
    this.flushCount++;
  }

  end(): void {
    this.flush();
    this.drawing = false;
    this.program = null;
  }

  get queuedQuads(): number {
    return this.quadCount;
  }

  dispose(): void {
    const gl = this.device.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
  }
}

/**
 * Packs normalised RGBA into a single uint32, as the vertex format expects.
 *
 * Values are clamped, not masked. Masking an over-range channel wraps it: a
 * hit flash passing 4.0 became 1020, which `& 0xff` turns into 252 — very
 * nearly the original colour, so the flash silently did nothing at all.
 */
const toByte = (value: number): number => {
  const scaled = value * 255;
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled | 0;
};

export const packColor = (r: number, g: number, b: number, a = 1): number =>
  (toByte(r) << 24) | (toByte(g) << 16) | (toByte(b) << 8) | toByte(a);

/** Packs a {@link SpriteMaterial} into a single uint32. */
export const packMaterial = (
  emissive: number,
  roughness: number,
  metallic: number,
  translucency: number,
): number =>
  (toByte(emissive) << 24) |
  (toByte(roughness) << 16) |
  (toByte(metallic) << 8) |
  toByte(translucency);

export const WHITE = packColor(1, 1, 1, 1);
export const DEFAULT_MATERIAL_PACKED = packMaterial(0, 0.65, 0.9, 0);
