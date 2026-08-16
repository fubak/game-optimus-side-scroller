/**
 * Fullscreen pass helper.
 *
 * Uses a single oversized triangle rather than two triangles forming a quad.
 * A quad's diagonal seam forces the GPU to shade the pixels along it twice
 * (quads are rasterised in 2x2 blocks that straddle the edge) and breaks the
 * derivative continuity that texture-filtering hardware relies on. One triangle
 * covering the whole viewport avoids both problems, and the pipeline runs more
 * than a dozen fullscreen passes per frame, so the saving compounds.
 */

import { Device, GfxError } from './device.ts';
import { Program } from './program.ts';

/**
 * Vertex shader for every fullscreen pass.
 *
 * Positions are generated from `gl_VertexID` alone, so no vertex buffer is
 * needed at all. Vertices 0, 1, 2 map to (-1,-1), (3,-1), (-1,3): a triangle
 * whose interior covers the entire [-1,1] clip-space square.
 */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;

out vec2 vUV;

void main() {
  vec2 corner = vec2(
    float((gl_VertexID << 1) & 2),
    float(gl_VertexID & 2)
  );
  vUV = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

export class FullscreenPass {
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly device: Device) {
    // WebGL2 still requires *some* VAO to be bound even when the shader reads
    // no attributes, so keep an empty one around.
    const vao = device.gl.createVertexArray();
    if (!vao) throw new GfxError('Could not create fullscreen VAO');
    this.vao = vao;
  }

  /** Draw the covering triangle. The caller binds the target and program. */
  draw(): void {
    this.device.bindVAO(this.vao);
    this.device.drawArrays(this.device.gl.TRIANGLES, 0, 3);
  }

  /** Bind a program, let the caller set uniforms, then draw. */
  run(program: Program, setup?: (program: Program) => void): void {
    program.use();
    setup?.(program);
    this.draw();
  }

  dispose(): void {
    this.device.gl.deleteVertexArray(this.vao);
  }
}
