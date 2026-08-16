/**
 * Shader compilation and uniform binding.
 *
 * Two things here earn their keep:
 *
 * **Readable compile errors.** GLSL reports failures as `ERROR: 0:47:
 * 'foo' : undeclared identifier`, which is useless when the source was
 * assembled from a template with injected defines. The compiler below reprints
 * the offending line with its neighbours, so a failure points straight at the
 * real code. On the headless capture machine, where there is no devtools
 * console to poke at, this is the difference between a two-minute fix and an
 * afternoon.
 *
 * **Uniform introspection with change filtering.** Uniform locations are looked
 * up once at link time, and every setter compares against the last value
 * uploaded. Redundant `uniform*` calls are a real cost in a renderer that binds
 * a dozen post-process passes per frame.
 */

import { Device, GfxError } from './device.ts';

interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  size: number;
  /** Last uploaded value, used to filter redundant uploads. */
  cached: number | number[] | null;
}

export interface ProgramOptions {
  /** `#define` values injected after the `#version` line. */
  defines?: Record<string, string | number | boolean>;
  /** Label used in error messages. */
  name?: string;
}

export class Program {
  readonly handle: WebGLProgram;
  readonly name: string;
  private readonly uniforms = new Map<string, UniformInfo>();
  private readonly attributes = new Map<string, number>();
  /** Uniform names already reported as missing, to avoid log spam. */
  private readonly warnedMissing = new Set<string>();

  constructor(
    private readonly device: Device,
    vertexSource: string,
    fragmentSource: string,
    options: ProgramOptions = {},
  ) {
    const gl = device.gl;
    this.name = options.name ?? 'unnamed';

    const defines = options.defines ?? {};
    const vs = this.compile(gl.VERTEX_SHADER, injectDefines(vertexSource, defines), 'vertex');
    const fs = this.compile(gl.FRAGMENT_SHADER, injectDefines(fragmentSource, defines), 'fragment');

    const program = gl.createProgram();
    if (!program) throw new GfxError(`Could not create program "${this.name}"`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    // Shaders can be flagged for deletion immediately; the program keeps them
    // alive until it is itself deleted.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new GfxError(`Link failed for program "${this.name}":\n${log}`);
    }

    this.handle = program;
    this.introspect();
  }

  private compile(type: number, source: string, stage: string): WebGLShader {
    const gl = this.device.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new GfxError(`Could not create ${stage} shader for "${this.name}"`);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '(no log)';
      gl.deleteShader(shader);
      throw new GfxError(
        `Compile failed for ${stage} shader "${this.name}":\n${log}\n\n` +
          annotateSource(source, log),
      );
    }
    return shader;
  }

  private introspect(): void {
    const gl = this.device.gl;

    const uniformCount = gl.getProgramParameter(this.handle, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(this.handle, i);
      if (!info) continue;
      // Array uniforms are reported as `name[0]`; store them under the bare name.
      const name = info.name.replace(/\[0\]$/, '');
      const location = gl.getUniformLocation(this.handle, info.name);
      if (!location) continue;
      this.uniforms.set(name, { location, type: info.type, size: info.size, cached: null });
    }

    const attributeCount = gl.getProgramParameter(this.handle, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < attributeCount; i++) {
      const info = gl.getActiveAttrib(this.handle, i);
      if (!info) continue;
      this.attributes.set(info.name, gl.getAttribLocation(this.handle, info.name));
    }
  }

  use(): void {
    this.device.useProgram(this.handle);
  }

  getAttribLocation(name: string): number {
    return this.attributes.get(name) ?? -1;
  }

  hasUniform(name: string): boolean {
    return this.uniforms.has(name);
  }

  /**
   * Looks up a uniform, warning once if it is absent.
   *
   * A missing uniform is usually benign — the GLSL compiler strips anything
   * that does not affect the output, so a uniform used only in a disabled
   * branch legitimately vanishes. It is worth surfacing once, because the other
   * cause is a typo that silently does nothing.
   */
  private find(name: string): UniformInfo | null {
    const info = this.uniforms.get(name);
    if (info) return info;
    if (!this.warnedMissing.has(name)) {
      this.warnedMissing.add(name);
      console.warn(`[gfx] uniform "${name}" not active in program "${this.name}"`);
    }
    return null;
  }

  setFloat(name: string, value: number): void {
    const u = this.find(name);
    if (!u || u.cached === value) return;
    u.cached = value;
    this.device.gl.uniform1f(u.location, value);
  }

  setInt(name: string, value: number): void {
    const u = this.find(name);
    if (!u || u.cached === value) return;
    u.cached = value;
    this.device.gl.uniform1i(u.location, value);
  }

  setBool(name: string, value: boolean): void {
    this.setInt(name, value ? 1 : 0);
  }

  setVec2(name: string, x: number, y: number): void {
    const u = this.find(name);
    if (!u) return;
    const c = u.cached as number[] | null;
    if (c && c.length === 2 && c[0] === x && c[1] === y) return;
    u.cached = [x, y];
    this.device.gl.uniform2f(u.location, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const u = this.find(name);
    if (!u) return;
    const c = u.cached as number[] | null;
    if (c && c.length === 3 && c[0] === x && c[1] === y && c[2] === z) return;
    u.cached = [x, y, z];
    this.device.gl.uniform3f(u.location, x, y, z);
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const u = this.find(name);
    if (!u) return;
    const c = u.cached as number[] | null;
    if (c && c.length === 4 && c[0] === x && c[1] === y && c[2] === z && c[3] === w) return;
    u.cached = [x, y, z, w];
    this.device.gl.uniform4f(u.location, x, y, z, w);
  }

  /** Uploads a 3x3 matrix. Arrays are always uploaded; caching them is not worth the compare. */
  setMat3(name: string, value: Float32Array): void {
    const u = this.find(name);
    if (!u) return;
    this.device.gl.uniformMatrix3fv(u.location, false, value);
  }

  setFloatArray(name: string, value: Float32Array): void {
    const u = this.find(name);
    if (!u) return;
    this.device.gl.uniform1fv(u.location, value);
  }

  setVec2Array(name: string, value: Float32Array): void {
    const u = this.find(name);
    if (!u) return;
    this.device.gl.uniform2fv(u.location, value);
  }

  setVec3Array(name: string, value: Float32Array): void {
    const u = this.find(name);
    if (!u) return;
    this.device.gl.uniform3fv(u.location, value);
  }

  setVec4Array(name: string, value: Float32Array): void {
    const u = this.find(name);
    if (!u) return;
    this.device.gl.uniform4fv(u.location, value);
  }

  /** Binds a texture to `unit` and points the sampler uniform at it. */
  setTexture(name: string, unit: number, texture: WebGLTexture | null): void {
    this.device.bindTexture(unit, texture);
    this.setInt(name, unit);
  }

  dispose(): void {
    this.device.gl.deleteProgram(this.handle);
    this.uniforms.clear();
    this.attributes.clear();
  }
}

/**
 * Inserts `#define` directives immediately after the `#version` line.
 *
 * GLSL ES 3.0 requires `#version 300 es` to be the very first thing in the
 * source — even a leading blank line is a compile error — so defines cannot
 * simply be prepended.
 */
export function injectDefines(
  source: string,
  defines: Record<string, string | number | boolean>,
): string {
  const entries = Object.entries(defines);
  if (entries.length === 0) return source;

  const lines = entries.map(([key, value]) => {
    if (typeof value === 'boolean') return value ? `#define ${key} 1` : `#define ${key} 0`;
    return `#define ${key} ${value}`;
  });

  const versionMatch = source.match(/^\s*#version[^\n]*\n/);
  if (versionMatch) {
    const index = versionMatch[0].length;
    return source.slice(0, index) + lines.join('\n') + '\n' + source.slice(index);
  }
  return lines.join('\n') + '\n' + source;
}

/**
 * Reprints the source lines referenced by a compiler log.
 *
 * Turns `ERROR: 0:47: ...` into an actual excerpt of lines 44-50 with the
 * failing line marked, which is what makes headless shader debugging tractable.
 */
function annotateSource(source: string, log: string): string {
  const lines = source.split('\n');
  const lineNumbers = new Set<number>();
  for (const match of log.matchAll(/ERROR:\s*\d+:(\d+)/g)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) lineNumbers.add(n);
  }
  if (lineNumbers.size === 0) return '';

  const out: string[] = [];
  for (const n of [...lineNumbers].sort((a, b) => a - b)) {
    out.push(`--- around line ${n} ---`);
    for (let i = Math.max(1, n - 3); i <= Math.min(lines.length, n + 3); i++) {
      const marker = i === n ? '>>' : '  ';
      out.push(`${marker} ${String(i).padStart(4)} | ${lines[i - 1] ?? ''}`);
    }
  }
  return out.join('\n');
}
