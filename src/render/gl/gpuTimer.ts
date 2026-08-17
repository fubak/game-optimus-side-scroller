/**
 * Approximate GPU frame timing via `EXT_disjoint_timer_query_webgl2`.
 *
 * WebGL2 draw calls are asynchronous, so "how long did the GPU spend on this frame" can only be
 * measured with a timer query object whose result is read back a frame or two later — reading it
 * synchronously would stall the whole pipeline waiting on the GPU. This wraps that latency behind
 * a small `begin()`/`end()`/`lastMs` API that degrades to `null` cleanly when the extension (or
 * WebGL2 itself) is unavailable, so callers never need a capability check of their own.
 */

/** The subset of the extension's own tokens/methods not already on `WebGL2RenderingContext`. */
interface DisjointTimerExt {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

/** Bound on pending (not-yet-available) queries, so a stalled driver cannot leak them forever. */
const MAX_INFLIGHT = 4;

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: DisjointTimerExt | null;
  private readonly inflight: WebGLQuery[] = [];
  private activeQuery: WebGLQuery | null = null;
  private lastMsValue: number | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerExt | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** Most recently resolved frame time in milliseconds, or `null` if none has resolved yet. */
  get lastMs(): number | null {
    return this.lastMsValue;
  }

  /** Start timing GPU work for this frame. No-op if unsupported or a query is already open. */
  begin(): void {
    if (this.ext === null || this.activeQuery !== null) return;
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.activeQuery = query;
  }

  /** Close this frame's query and queue it for (non-blocking) readback. */
  end(): void {
    if (this.ext === null || this.activeQuery === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inflight.push(this.activeQuery);
    this.activeQuery = null;
    this.pollInflight();
  }

  /** Consume any pending queries whose result is ready. Never blocks on the GPU. */
  private pollInflight(): void {
    const { gl, ext } = this;
    if (ext === null) return;
    while (this.inflight.length > MAX_INFLIGHT) {
      const stale = this.inflight.shift();
      if (stale !== undefined) gl.deleteQuery(stale);
    }
    while (this.inflight.length > 0) {
      const query = this.inflight[0];
      if (query === undefined) break;
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      this.inflight.shift();
      if (!disjoint) {
        this.lastMsValue = nanoseconds / 1e6;
      }
    }
  }

  dispose(): void {
    const { gl } = this;
    if (this.activeQuery !== null) {
      gl.deleteQuery(this.activeQuery);
      this.activeQuery = null;
    }
    for (const query of this.inflight) gl.deleteQuery(query);
    this.inflight.length = 0;
  }
}
