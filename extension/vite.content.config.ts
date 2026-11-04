import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts run as classic scripts, so each is built on its own into one self-contained
// file (the pages' build splits shared code into ES module chunks). CONTENT picks which one:
// fill (Greenhouse and Workday pages) or site (the job site).
const name = process.env.CONTENT === 'site' ? 'site' : 'fill';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: resolve(import.meta.dirname, `src/content/${name}.ts`),
      formats: ['iife'],
      name: 'JobAutofill',
      fileName: () => `content/${name}.js`,
    },
  },
});
