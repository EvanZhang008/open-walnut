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
 * Polls the file's stat (fs.watchFile), as config-file-watch.ts does for
 * config.yaml: it goes by path, so the atomic rename-replace that editors and the
 * CLI itself use is seen, and it costs the event loop nothing to start. It used
 * to be an fs.watch of ~/.claude: on macOS that call blocked the loop while the
 * file-event stream started, about half a second at every boot of a loaded Mac
 * (2026-11-24: 4.3 s of `watch (native)` under watchClaudeSettings in 8 kept boot
 * stall profiles), for a file that changes a few times a month.
 */
import fs from 'node:fs';
import { CLAUDE_SETTINGS_FILE } from '../constants.js';
import { log } from '../logging/index.js';

const DEBOUNCE_MS = 2_000;
const POLL_MS = 5_000;

export interface ClaudeSettingsWatchOptions { file?: string; pollMs?: number; debounceMs?: number }

export function watchClaudeSettings(onChange: () => void, opts: ClaudeSettingsWatchOptions = {}): () => void {
  const file = opts.file ?? CLAUDE_SETTINGS_FILE;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const listener = (cur: fs.Stats, prev: fs.Stats): void => {
    // A file that is missing reads as all-zero stats on both sides: nothing to tell.
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size && cur.ino === prev.ino) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      log.session.info('claude settings.json changed — refreshing model catalogs');
      try { onChange(); } catch (err) {
        log.session.warn('settings-change catalog refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, debounceMs);
    timer.unref?.();
  };
  try {
    fs.watchFile(file, { interval: opts.pollMs ?? POLL_MS, persistent: false }, listener);
  } catch (err) {
    log.session.warn('cannot watch claude settings', { error: err instanceof Error ? err.message : String(err) });
    return () => {};
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    fs.unwatchFile(file, listener);
  };
}
