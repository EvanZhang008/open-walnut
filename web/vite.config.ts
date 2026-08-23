import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@open-walnut/core': path.resolve(__dirname, '../src/core/types.ts'),
      // Separate alias (NOT folded into @open-walnut/core): task-query.ts is the
      // shared pure query model — browser-safe, no db/config/logging imports —
      // reused verbatim by REST, the agent tool and both task surfaces.
      '@open-walnut/task-query': path.resolve(__dirname, '../src/core/task-query.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3456',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle the office renderers instead of discovering them on the first
    // office-file click. They are large CommonJS libraries (SheetJS alone ~1MB),
    // and vite's on-demand "new dependencies optimized" path FULL-PAGE-RELOADS
    // when it finds them mid-session — which drops the preview that just
    // mounted, and made the browser tests flake on whichever office spec ran
    // first in a cold run.
    include: ['xlsx', 'docx-preview', 'pptx-preview'],
  },
  build: {
    outDir: '../dist/web/static',
    emptyOutDir: true,
  },
});
