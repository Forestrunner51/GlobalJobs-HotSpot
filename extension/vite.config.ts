import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Extension pages are built from src/ into dist/ with the same relative paths, so the manifest
// (copied from public/) can point at popup/popup.html, options/options.html and background.js.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  publicDir: resolve(import.meta.dirname, 'public'),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    // In watch mode the content script's build writes into dist/ too; don't wipe it on rebuild.
    emptyOutDir: !process.argv.includes('--watch'),
    target: 'es2022',
    // The polyfill is an inline script, which extension pages' CSP blocks; Chromium doesn't need it.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        options: resolve(import.meta.dirname, 'src/options/options.html'),
        applications: resolve(import.meta.dirname, 'src/applications/applications.html'),
        background: resolve(import.meta.dirname, 'src/background.ts'),
      },
      // The manifest names the service worker, so it can't have a hashed file name.
      output: { entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js') },
    },
  },
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
  },
});
