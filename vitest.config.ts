import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html'],
      // Rendering code paints to a canvas and is verified visually / in the browser smoke test,
      // so it is excluded from coverage thresholds. Simulation code is covered by unit tests.
      include: ['src/core/**/*.ts', 'src/game/**/*.ts'],
      exclude: ['src/game/levels/**'],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
