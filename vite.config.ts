import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Inlines every emitted JS/CSS chunk (and any small binary asset) directly into
 * `index.html`, producing a genuinely self-contained single file that can be
 * opened straight off the filesystem with `file://`.
 *
 * We roll our own rather than pulling in `vite-plugin-singlefile` because the
 * project has a hard "zero runtime dependencies" rule and this is ~50 lines.
 */
function singleFile(): Plugin {
  return {
    name: 'optimus:single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find((k) => k.endsWith('.html'));
      if (!htmlKey) return;
      const html = bundle[htmlKey];
      if (!html || html.type !== 'asset') return;

      let source = String(html.source);

      for (const [key, chunk] of Object.entries(bundle)) {
        if (key === htmlKey) continue;

        if (chunk.type === 'chunk') {
          // Replace the <script src="..."> tag with the module source inline.
          const tag = new RegExp(
            `<script[^>]*src="[^"]*${escapeRegExp(chunk.fileName)}"[^>]*></script>`,
          );
          source = source.replace(
            tag,
            `<script type="module">\n${chunk.code}\n</script>`,
          );
          delete bundle[key];
        } else if (chunk.fileName.endsWith('.css')) {
          const tag = new RegExp(
            `<link[^>]*href="[^"]*${escapeRegExp(chunk.fileName)}"[^>]*>`,
          );
          source = source.replace(tag, `<style>\n${String(chunk.source)}\n</style>`);
          delete bundle[key];
        }
      }

      // Any remaining absolute asset references would break under file://.
      source = source.replace(/(src|href)="\/(?!\/)/g, '$1="./');
      html.source = source;
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the build stamp so the running game can report exactly which revision
 * produced it — the capture harness records this alongside every screenshot so
 * a critique can always be traced back to a specific build.
 */
function buildStamp(): string {
  try {
    const head = readFileSync(resolve(__dirname, '.git/HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      return readFileSync(resolve(__dirname, '.git', ref), 'utf8').trim().slice(0, 8);
    }
    return head.slice(0, 8);
  } catch {
    return 'nogit';
  }
}

export default defineConfig(({ mode }) => ({
  plugins: mode === 'singlefile' ? [singleFile()] : [],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  define: {
    __BUILD_REV__: JSON.stringify(buildStamp()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    outDir: mode === 'singlefile' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'singlefile' ? 100_000_000 : 4096,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // A single chunk keeps the self-contained build simple and avoids
        // dynamic-import machinery that does not work under file://.
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
    // Shaders and gameplay tuning tables benefit from readable output when
    // debugging a capture, but shipping builds stay minified.
    minify: 'esbuild',
    sourcemap: mode !== 'singlefile',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
}));
