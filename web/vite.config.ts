import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { restateOwnOrigin } from './dev-proxy-origin';
import { pdfAssets } from './pdf-assets';

export default defineConfig({
  plugins: [react(), pdfAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@open-walnut/core': path.resolve(__dirname, '../src/core/types.ts'),
      // Separate alias (NOT folded into @open-walnut/core): task-query.ts is the
      // shared pure query model — browser-safe, no db/config/logging imports —
      // reused verbatim by REST, the agent tool and both task surfaces.
      '@open-walnut/task-query': path.resolve(__dirname, '../src/core/task-query.ts'),
      // Same reason: the letter reader's frame + CSP floor is ONE module, because
      // the server streams big letter bodies pre-wrapped in that exact frame.
      '@open-walnut/letter-frame': path.resolve(__dirname, '../src/core/human-inbox/letter-frame.ts'),
      // Same reason again: "does this stream end mid-tag" must have ONE answer,
      // because the browser reducer and the server-side stream buffer are twins
      // and a rule only one of them applies reappears as an artifact on reload.
      '@open-walnut/pending-markup': path.resolve(__dirname, '../src/core/stream/pending-markup.ts'),
      '@open-walnut/service-url': path.resolve(__dirname, '../src/core/service-url.ts'),
      // Same reason, third time: "one compaction is one row" must hold in the
      // browser reducer AND in the server stream buffer, or the row count changes
      // when a reload swaps which twin produced the timeline.
      '@open-walnut/compaction-notice': path.resolve(__dirname, '../src/core/stream/compaction-notice.ts'),
      // The message-hint wire format: the client reads and strips the very blocks the server writes.
      '@open-walnut/hint-format': path.resolve(__dirname, '../src/core/hints/hint-format.ts'),
      // Same reason once more: the ✦ search's prompt and answer are BUILT by the
      // server and READ BACK by the transcript renderer, so the sentinels and
      // their parser must have one owner or a card silently stops matching.
      '@open-walnut/search-transcript': path.resolve(__dirname, '../src/core/task-search-transcript.ts'),
      // Same reason: a remote host problem must read the SAME sentence on the
      // banner, the picker, Settings and the server's Start refusal (409 body).
      '@open-walnut/host-problem': path.resolve(__dirname, '../src/core/hosts/host-problem.ts'),
      // The asks list (membership, order, title, state): the same module
      // GET /api/v1/asks serves the phone from, so the drawer and the phone agree.
      '@open-walnut/ask-list': path.resolve(__dirname, '../src/core/sessions/ask-list.ts'),
      // The org (who reports to whom): the same function GET /api/v1/org builds from.
      '@open-walnut/org-tree': path.resolve(__dirname, '../src/core/org/org-tree.ts'),
      '@open-walnut/user-status': path.resolve(__dirname, '../src/core/user-status.ts'),
      '@open-walnut/live-activity': path.resolve(__dirname, '../src/core/live-activity.ts'),
      // Where the cloud companion's keep choice lives: Settings reads it as the server does.
      '@open-walnut/companion-keep': path.resolve(__dirname, '../src/core/replication/companion-keep.ts'),
      '@open-walnut/history-turn-window': path.resolve(__dirname, '../src/lib/history-turn-window.ts'),
      '@open-walnut/history-injected-banner': path.resolve(__dirname, '../src/lib/history-injected-banner.ts'),
      '@open-walnut/history-session-envelope': path.resolve(__dirname, '../src/lib/history-session-envelope.ts'),
      '@open-walnut/history-walnut-riders': path.resolve(__dirname, '../src/lib/history-walnut-riders.ts'),
      '@open-walnut/walnut-added': path.resolve(__dirname, '../src/lib/walnut-added.ts'),
      '@open-walnut/three-way-merge': path.resolve(__dirname, '../src/lib/three-way-merge.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // restateOwnOrigin: the server trusts only its own Origin (see the module).
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
        configure: (proxy) => restateOwnOrigin(proxy, 'http://localhost:3456'),
      },
      '/ws': {
        target: 'ws://localhost:3456',
        ws: true,
        configure: (proxy) => restateOwnOrigin(proxy, 'ws://localhost:3456'),
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
    include: ['xlsx', 'docx-preview', 'pptx-preview', 'pdfjs-dist'],
  },
  build: {
    outDir: '../dist/web/static',
    emptyOutDir: true,
  },
});
