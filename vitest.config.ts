import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The UI tests are .tsx; compile JSX with React 19's automatic runtime so no import is needed.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
  test: {
    environment: "node",
    include: ["tests-js/**/*.test.ts", "tests-js/**/*.test.tsx"],
    setupFiles: ["tests-js/setup.ts"],
    // ffmpeg integration tests encode real videos.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each test file gets its own process: the database and storage tests use temp directories
    // and the encoding tests spawn ffmpeg.
    pool: "forks",
    reporters: ["default"],
  },
});
