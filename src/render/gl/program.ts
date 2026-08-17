/**
 * Shader compilation and a small `Program` wrapper.
 *
 * Every failure here is a build-time bug (a typo in a shader, a uniform name that no longer
 * matches), so compile/link errors throw immediately with the driver's log attached rather than
 * failing silently or logging and carrying on.
 */

/** Compile a single shader stage, throwing with the driver's log on failure. */
export function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error('Failed to allocate a WebGL shader object.');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!(gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no shader log)';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : type === gl.FRAGMENT_SHADER ? 'fragment' : 'unknown';
    throw new Error(`Failed to compile ${kind} shader:\n${log}\n--- source ---\n${source}`);
  }
  return shader;
}

/** Compile and link a vertex/fragment pair, throwing with the driver's log on failure. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  // Shaders can be detached once linked; the program keeps its own compiled copy.
  gl.detachShader(program, vertexShader);
  gl.detachShader(program, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!(gl.getProgramParameter(program, gl.LINK_STATUS) as boolean)) {
    const log = gl.getProgramInfoLog(program) ?? '(no program log)';
    gl.deleteProgram(program);
    throw new Error(`Failed to link program:\n${log}`);
  }
  return program;
}

/**
 * A linked program plus cached attribute/uniform locations.
 *
 * Location lookups (`getAttribLocation`/`getUniformLocation`) are driver round-trips, so every
 * lookup is cached the first time it happens and reused for the life of the program.
 */
export class Program {
  readonly gl: WebGL2RenderingContext;
  readonly handle: WebGLProgram;

  private readonly attribLocations = new Map<string, number>();
  private readonly uniformLocations = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
    this.gl = gl;
    this.handle = linkProgram(gl, vertexSource, fragmentSource);
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  /** Cached `getAttribLocation`; throws if the attribute was optimized out or misspelled. */
  attribLocation(name: string): number {
    const cached = this.attribLocations.get(name);
    if (cached !== undefined) return cached;
    const location = this.gl.getAttribLocation(this.handle, name);
    if (location === -1) {
      throw new Error(`Attribute "${name}" was not found on this program.`);
    }
    this.attribLocations.set(name, location);
    return location;
  }

  /** Cached `getUniformLocation`. Unlike attributes, a missing uniform is a silent no-op set. */
  private uniformLocation(name: string): WebGLUniformLocation | null {
    const cached = this.uniformLocations.get(name);
    if (cached !== undefined) return cached;
    const location = this.gl.getUniformLocation(this.handle, name);
    this.uniformLocations.set(name, location);
    return location;
  }

  setUniform1f(name: string, x: number): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniform1f(location, x);
  }

  setUniform2f(name: string, x: number, y: number): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniform2f(location, x, y);
  }

  setUniform3f(name: string, x: number, y: number, z: number): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniform3f(location, x, y, z);
  }

  setUniform4f(name: string, x: number, y: number, z: number, w: number): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniform4f(location, x, y, z, w);
  }

  setUniform1i(name: string, x: number): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniform1i(location, x);
  }

  /** Upload a column-major 3x3 matrix (9 floats). */
  matrix3fv(name: string, value: Float32Array | readonly number[]): void {
    const location = this.uniformLocation(name);
    if (location !== null) this.gl.uniformMatrix3fv(location, false, value);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
    this.attribLocations.clear();
    this.uniformLocations.clear();
  }
}
