/**
 * Filesystem watcher for the two markdown roots the search index and the
 * notes reconciler care about.
 *
 * NOTES_DIR: git-synced notes never pass through a write route, so without fs
 * events the FTS index only refreshes on the once-per-boot drift scan — every
 * note synced after that stayed unsearchable until the next restart (dogfood
 * R14). This watcher is the only inotify registration on the vault; it also
 * feeds binary attachments (PDF/images) to the out-of-process text extractor.
 *
 * MEMORY_DIR: memory files are written by the AI mid-conversation; each
 * change notifies git-versioning (auto-commit) and upserts the single file
 * into the search index so it is recallable within seconds, not at the next
 * 10-min sweep.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, NOTES_DIR } from '../constants.js';
import {
  resetNotesIndexer,
  scheduleNotesIndexUpdate,
  stopNotesIndexer,
} from './notes-indexer.js';
import { log } from '../logging/index.js';

function notifyGitVersioning(filename: string): void {
  import('./git-versioning.js')
    .then(({ getGitVersioning }) => { getGitVersioning()?.notifyMemoryChange(filename); })
    .catch(() => {});
}

export function startNotesWatcher(opts?: { semantic?: boolean }): { stop: () => void } {
  // semantic:false = structural-only mode (cloud replica / WALNUT_DISABLE_SEARCH):
  // the NOTES_DIR leg must still run there (see R14 above), but nothing feeds
  // the search index.
  const semantic = opts?.semantic !== false;
  const watchers: fs.FSWatcher[] = [];
  resetNotesIndexer();

  // Per-path coalescing for memory files: fs.watch fires several events per
  // save, and the AI often rewrites the same file repeatedly in one turn.
  const pendingMemory = new Set<string>();
  let memoryTimer: ReturnType<typeof setTimeout> | null = null;
  const flushMemory = () => {
    memoryTimer = null;
    const paths = [...pendingMemory];
    pendingMemory.clear();
    void import('./search/wiring.js')
      .then(async ({ upsertSearchV2File }) => {
        for (const p of paths) await upsertSearchV2File('memory', p);
      })
      .catch((err) => {
        log.agent.debug('memory search upsert failed', { error: err instanceof Error ? err.message : String(err) });
      });
  };
  const scheduleMemoryUpsert = (absPath: string) => {
    pendingMemory.add(absPath);
    if (memoryTimer) clearTimeout(memoryTimer);
    memoryTimer = setTimeout(flushMemory, 2000);
  };

  try {
    if (semantic && fs.existsSync(MEMORY_DIR)) {
      watchers.push(fs.watch(MEMORY_DIR, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          scheduleMemoryUpsert(path.join(MEMORY_DIR, filename));
          notifyGitVersioning(filename);
        }
      }));
    }
    if (fs.existsSync(NOTES_DIR)) {
      // ONE inotify registration → the structural sidecar reconciler, which
      // ALSO drives the search index per changed file. The reconciler has its
      // own per-path coalescing queue + debounce, so we hand it the changed path.
      watchers.push(fs.watch(NOTES_DIR, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (filename.endsWith('.md')) {
          scheduleNotesIndexUpdate(filename);
        } else {
          // Binary attachments (PDF/images) → serial out-of-process text
          // extraction. isExtractableAttachment gates extensions inside.
          import('./attachment-text.js')
            .then(({ scheduleAttachmentExtract }) => { void scheduleAttachmentExtract(filename); })
            .catch(() => {});
        }
      }));
    }
  } catch { /* graceful */ }

  return {
    stop() {
      if (memoryTimer) { clearTimeout(memoryTimer); memoryTimer = null; }
      pendingMemory.clear();
      // Stop the notes reconciler's debounce timer so no reconcile fires after
      // the watcher is torn down (ephemeral-server isolation / clean shutdown).
      stopNotesIndexer();
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}
