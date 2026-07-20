/**
 * Watch ~/.claude/settings.json for changes and notify a callback (debounced).
 *
 * Why: the model catalog is a pure function of (host, settings.json). Running
 * CLIs hot-reload settings internally, but nothing used to tell Walnut — so an
 * edited availableModels/modelOverrides left every picker and the host-catalog
 * store stale until the next process spawn. This watcher closes that gap for
 * the LOCAL host: on change, the session runner force-refetches list_models
 * from a live local CLI, which pushes the fresh catalog to all clients.
 * (Remote hosts refresh on next spawn or via the picker's manual ⟳.)
 *
 * Watches the parent directory, not the file: editors and the CLI itself write
 * settings.json via rename (atomic replace), which breaks a file-level watch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_SETTINGS_FILE } from '../constants.js';
import { log } from '../logging/index.js';

const DEBOUNCE_MS = 2_000;

export function watchClaudeSettings(onChange: () => void): () => void {
  const dir = path.dirname(CLAUDE_SETTINGS_FILE);
  const file = path.basename(CLAUDE_SETTINGS_FILE);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== file) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        log.session.info('claude settings.json changed — refreshing model catalogs');
        try { onChange(); } catch (err) {
          log.session.warn('settings-change catalog refresh failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    // Missing ~/.claude or unsupported fs — degrade to no watching.
    log.session.warn('cannot watch claude settings', {
      error: err instanceof Error ? err.message : String(err),
    });
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
