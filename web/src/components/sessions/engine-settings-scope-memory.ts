/**
 * The write-scope switch's memory for EngineSettingsPopover.
 *
 * One localStorage key per engine + host + working directory. The memory is
 * written only when the user picks a side, which the popover allows only after
 * the server said the project layer exists, so the next open can ask for the
 * remembered scope on its FIRST request (one round trip instead of a default
 * read followed by a re-read). Two safety nets: a session without a cwd never
 * starts on `project`, and a first load the server refuses under the remembered
 * scope is retried once with the default; if that answer says the project layer
 * is gone, the memory is forgotten so the next open does not pay again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LOCAL_HOST, type EngineSettingsWriteScope } from '@/api/engine-settings';
import { useEngineSettings, type EngineSettingsHook } from '@/hooks/useEngineSettings';
import { scopeStorageKey } from '@/utils/engine-settings-copy';
import { log } from '@/utils/log';

/** The scope to ask for on the first request: the remembered one, but never `project` without a cwd. */
export function rememberedScope(storageKey: string, cwd: string | undefined): EngineSettingsWriteScope {
  if (!cwd) return 'default';
  try { return localStorage.getItem(storageKey) === 'project' ? 'project' : 'default'; } catch { return 'default'; }
}

function forgetScope(storageKey: string): void {
  try { localStorage.removeItem(storageKey); } catch { /* private mode */ }
}

export interface ScopedEngineSettingsArgs {
  sessionId: string;
  engine: string;
  host: string | undefined;
  cwd: string | undefined;
  open: boolean;
}

export interface ScopedEngineSettings {
  scope: EngineSettingsWriteScope;
  /** The user picked a side: switch to it and remember it for this engine, host and directory. */
  pick: (next: EngineSettingsWriteScope) => void;
  /** The load and the save machinery for the current scope (useEngineSettings). */
  settings: EngineSettingsHook;
}

/** Owns the scope AND the load for it: the memory needs the load's outcome to know whether it was honoured. */
export function useScopedEngineSettings(args: ScopedEngineSettingsArgs): ScopedEngineSettings {
  const { sessionId, engine, host, cwd, open } = args;
  const storageKey = scopeStorageKey(host || LOCAL_HOST, cwd ?? '', engine);
  const [scope, setScope] = useState<EngineSettingsWriteScope>(() => rememberedScope(storageKey, cwd));
  const settings = useEngineSettings(engine, { sessionId, scope }, open);
  const { view, loadError } = settings;
  /** The first load under a remembered project scope failed and the default scope is being tried. */
  const fellBackRef = useRef(false);

  // Each open starts on the remembered scope (re-read on close, so a pick made during the open counts next time).
  useEffect(() => {
    if (open) return;
    setScope(rememberedScope(storageKey, cwd));
    fellBackRef.current = false;
  }, [open, storageKey, cwd]);

  // A memory the server no longer honours (no project layer for this engine and
  // cwd) is stale: back to the default, and forgotten.
  useEffect(() => {
    if (!view) return;
    if (!view.projectScopeAvailable && (scope === 'project' || fellBackRef.current)) { setScope('default'); forgetScope(storageKey); }
    fellBackRef.current = false;
  }, [view, scope, storageKey]);

  // The remembered scope failed on the FIRST load: retry once with the default
  // instead of a dead first-load error the user did not cause. Whether the
  // memory was the reason is decided by the answer that follows (above).
  useEffect(() => {
    if (!loadError || loadError.phase !== 'initial' || scope !== 'project') return;
    log.warn('settings', 'engine settings remembered project scope failed to load, retrying with the default', { sessionId, engine, error: loadError.message });
    fellBackRef.current = true;
    setScope('default');
  }, [loadError, scope, sessionId, engine]);

  const pick = useCallback((next: EngineSettingsWriteScope) => {
    setScope(next);
    try { localStorage.setItem(storageKey, next); } catch { /* private mode: memory is a nicety */ }
  }, [storageKey]);

  return { scope, pick, settings };
}
