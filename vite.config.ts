import { defineConfig } from 'vite';

/**
 * `PAGES_BASE` is set by the GitHub Pages workflow (e.g. `/game-optimus-side-scroller/`)
 * so the built asset URLs resolve under the project sub-path. Locally we serve from root.
 */
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    // The whole game is one small bundle; splitting it would only add round-trips.
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
