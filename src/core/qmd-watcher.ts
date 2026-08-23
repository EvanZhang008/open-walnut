/**
 * Filesystem watcher that triggers QMD update+embed on markdown changes.
 * Replaces memory-watcher.ts for QMD-backed search.
 */
import fs from 'node:fs';
import { MEMORY_DIR, NOTES_DIR } from '../constants.js';
import { dispatchQmdIncrementalIndex } from './qmd-dispatcher.js';
import {
  resetNotesIndexer,
  scheduleNotesIndexUpdate,
  stopNotesIndexer,
} from './notes-indexer.js';
import { log } from '../logging/index.js';

function debounce(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

function notifyGitVersioning(filename: string): void {
  import('./git-versioning.js')
    .then(({ getGitVersioning }) => { getGitVersioning()?.notifyMemoryChange(filename); })
    .catch(() => {});
}

export function startQmdWatcher(opts?: { semantic?: boolean }): { stop: () => void } {
  // semantic:false = structural-only mode (cloud replica / hosts without the
  // optional qmd dep). The NOTES_DIR leg must still run there: git-synced
  // notes never pass through a write route, so without fs events the FTS
  // index only refreshes on the once-per-boot drift scan — every note synced
  // after that stayed unsearchable until the next restart (dogfood R14).
  // The memory leg is semantic-only work, so it stays off in this mode.
  const semantic = opts?.semantic !== false;
  const watchers: fs.FSWatcher[] = [];
  resetNotesIndexer();

  const scheduleMemoryUpdate = debounce(async () => {
    try {
      await dispatchQmdIncrementalIndex({ memory: true });
    } catch (err) {
      log.agent.debug('QMD memory update failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 2000);

  // NOTE: the notes store is NO LONGER driven by store.update() on file change.
  // store.update() synchronously re-globs + readFileSync's the WHOLE vault (now
  // **/*.md after the widen), an O(vault) event-loop-blocking pass (~456ms @1.5k
  // files, ~5.8s @20k) — the exact starvation class this project was burned by.
  // Instead, the structural reconciler (notes-indexer.ts) drives the semantic
  // store ONE changed file at a time (insertContent/insertDocument + incremental
  // embed). Full rebuilds use the same path over every note.

  try {
    if (semantic && fs.existsSync(MEMORY_DIR)) {
      watchers.push(fs.watch(MEMORY_DIR, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          scheduleMemoryUpdate.call();
          notifyGitVersioning(filename);
        }
      }));
    }
    // (MEMORY.md moved into memory/ — the recursive MEMORY_DIR watcher above
    // covers it now; the old WALNUT_HOME root watcher was removed.)
    if (fs.existsSync(NOTES_DIR)) {
      // ONE inotify registration → the structural sidecar reconciler, which ALSO
      // drives the semantic store per changed file (no second fs.watch, no
      // O(vault) store.update() on the save path). The reconciler has its own
      // per-path coalescing queue + debounce, so we hand it the changed path.
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
      scheduleMemoryUpdate.cancel();
      // Stop the notes reconciler's debounce timer so no reconcile fires after
      // the watcher is torn down (ephemeral-server isolation / clean shutdown).
      stopNotesIndexer();
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}
