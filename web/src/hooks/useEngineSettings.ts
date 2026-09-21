/**
 * useEngineSettings: load and edit one engine's own settings for one target,
 * shared by Settings › Engines (`{ host }`) and the composer's per-session
 * popover (`{ sessionId, scope }`).
 *
 * This edits files the ENGINE owns, not Walnut config, so three things are
 * deliberate and live here rather than in either surface:
 * - Every write answers with a FRESH read of the files and that answer replaces
 * the view (see engine-settings-model.ts for the two exceptions: a late
 * answer places only its own key, rows still in flight keep their optimistic
 * value). The optimistic value is only there so a toggle feels instant.
 * - A late answer for a target the user already left must never paint: one
 * generation counter plus an AbortController per load guarantees that.
 * - A load that cannot answer reports the server's own sentence and WHICH load
 * failed: the first one of this target (`initial`, nothing usable yet), a
 * scope switch (`rescope`, the other scope still worked) or a re-read
 * (`reload`). The popover keys its scope switch off that phase.
 *
 * A rescope or reload keeps the previous view visible (`refreshing`), so rows
 * get `aria-busy` instead of a skeleton; only a target with no view yet shows
 * `loading`. `banner` and `lastWrite` belong to the target and are cleared when
 * it changes, never by a reload a failed write asked for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { log } from '@/utils/log';
import {
  engineSettingsErrorText,
  fetchEngineSettings,
  isAbortError,
  patchEngineSettings,
  type EngineSettingValue,
  type EngineSettingView,
  type EngineSettingsPatch,
  type EngineSettingsTarget,
  type EngineSettingsView,
  type EngineSettingsWriteResult,
  type EngineSettingsWriteScope,
} from '@/api/engine-settings';
import { decideWriteFailure, findItem, mapItem, mergeLanded, optimisticReset, optimisticSet } from './engine-settings-model';

export type EngineSettingsHookTarget =
  | { host: string }
  | { sessionId: string; scope: EngineSettingsWriteScope };

export interface EngineSettingsLoadError {
  phase: 'initial' | 'rescope' | 'reload';
  message: string;
}

export interface EngineSettingsLastWrite {
  key: string;
  result: EngineSettingsWriteResult;
  scope: EngineSettingsWriteScope;
  /** `set` wrote a value, `unset` (Reset) removed the key: the footer sentence differs. */
  op: 'set' | 'unset';
  at: number;
}

export interface EngineSettingsHook {
  view: EngineSettingsView | null;
  /** True only while NO view is shown (the target's first load). */
  loading: boolean;
  /** A rescope or reload while a view is on screen: rows get aria-busy, no skeleton. */
  refreshing: boolean;
  loadError: EngineSettingsLoadError | null;
  banner: string | null;
  dismissBanner: () => void;
  savingKeys: readonly string[];
  lastWrite: EngineSettingsLastWrite | null;
  clearLastWrite: () => void;
  onSet: (key: string, value: EngineSettingValue) => void;
  onReset: (key: string) => void;
  reload: () => void;
}

/** The part of a target whose change means "another set of files": scope is excluded on purpose. */
function targetIdentity(engine: string | undefined, target: EngineSettingsHookTarget): string {
  if (!engine) return '';
  return 'host' in target ? `${engine}|host:${target.host}` : `${engine}|session:${target.sessionId}`;
}

export function useEngineSettings(
  engine: string | undefined,
  target: EngineSettingsHookTarget,
  enabled: boolean,
): EngineSettingsHook {
  const host = 'host' in target ? target.host : undefined;
  const sessionId = 'sessionId' in target ? target.sessionId : undefined;
  const scope: EngineSettingsWriteScope = 'sessionId' in target ? target.scope : 'default';
  const identity = targetIdentity(engine, target);
  const apiTarget = useMemo<EngineSettingsTarget>(
    () => (host !== undefined ? { host } : { sessionId, scope }),
    [host, sessionId, scope],
  );

  const [view, setView] = useState<EngineSettingsView | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [loadError, setLoadError] = useState<EngineSettingsLoadError | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [savingKeys, setSavingKeys] = useState<readonly string[]>([]);
  const [lastWrite, setLastWrite] = useState<EngineSettingsLastWrite | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Bumped by every load. A response from an older generation is dropped. */
  const genRef = useRef(0);
  /** Mirror of `savingKeys` for callbacks that must see the keys in flight RIGHT NOW, not at their closure's render. */
  const savingRef = useRef<readonly string[]>([]);
  savingRef.current = savingKeys;
  /** Mirror of `view`, same reason. */
  const viewRef = useRef<EngineSettingsView | null>(null);
  viewRef.current = view;
  /** Patches are numbered as they start; `landedSeq` is the newest one whose answer has painted. */
  const patchSeqRef = useRef(0);
  const landedSeqRef = useRef(0);
  /** The target the current view belongs to; a change of it (not a reload) clears banner and lastWrite. */
  const identityRef = useRef('');
  /** A view has painted for the current identity: a failure after that is a rescope/reload, not the first load. */
  const shownRef = useRef(false);
  /** The scope the last load was for, so a scope change is told apart from a reload. */
  const scopeRef = useRef<EngineSettingsWriteScope>(scope);

  useEffect(() => {
    if (!engine || !enabled) {
      // Closing the popover (or losing the engine) drops every in-flight answer
      // and forgets the target, so the next open starts as a first load.
      genRef.current += 1;
      identityRef.current = '';
      shownRef.current = false;
      setView(null);
      setInFlight(false);
      setLoadError(null);
      return;
    }
    const gen = ++genRef.current;
    const controller = new AbortController();
    let kind: EngineSettingsLoadError['phase'] = 'reload';
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      shownRef.current = false;
      kind = 'initial';
      setView(null);
      setBanner(null);
      setLastWrite(null);
    } else if (scopeRef.current !== scope) {
      kind = 'rescope';
      setBanner(null);
      setLastWrite(null);
    }
    scopeRef.current = scope;
    setInFlight(true);
    setLoadError(null);
    setSavingKeys([]);
    landedSeqRef.current = patchSeqRef.current;
    fetchEngineSettings(engine, apiTarget, { signal: controller.signal })
      .then((next) => {
        if (gen !== genRef.current) return;
        shownRef.current = true;
        setView(next);
        setInFlight(false);
      })
      .catch((err) => {
        if (gen !== genRef.current || isAbortError(err)) return;
        // Nothing has painted for this target yet, so whatever asked for the
        // load (a Retry included), the user still has no usable side.
        const phase = shownRef.current ? kind : 'initial';
        setView(null);
        setLoadError({ phase, message: engineSettingsErrorText(err) });
        setInFlight(false);
        log.warn('settings', 'engine settings load failed', { engine, host, sessionId, scope, phase, error: String(err) });
      });
    return () => { controller.abort(); };
  }, [engine, enabled, identity, apiTarget, host, sessionId, scope, reloadNonce]);

  const runPatch = useCallback((
    key: string,
    patch: EngineSettingsPatch,
    optimistic: (item: EngineSettingView) => EngineSettingView,
  ) => {
    const op: EngineSettingsLastWrite['op'] = patch.unset?.includes(key) ? 'unset' : 'set';
    const before = findItem(viewRef.current, key);
    if (!engine || !enabled || !before) return;
    const gen = genRef.current;
    const seq = ++patchSeqRef.current;
    const writeScope = scope;
    setView((prev) => (prev ? mapItem(prev, key, optimistic) : prev));
    setSavingKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    patchEngineSettings(engine, apiTarget, patch)
      .then((result) => {
        if (gen !== genRef.current) return;
        setView((prev) => {
          const landed = mergeLanded({
            prev, next: result, key, seq, landedSeq: landedSeqRef.current, savingKeys: savingRef.current,
          });
          landedSeqRef.current = landed.landedSeq;
          return landed.view;
        });
        setBanner(null);
        setLastWrite({ key, result, scope: writeScope, op, at: Date.now() });
      })
      .catch((err) => {
        if (gen !== genRef.current) return;
        setBanner(engineSettingsErrorText(err));
        log.warn('settings', 'engine setting update failed', { engine, host, sessionId, scope, key, error: String(err) });
        if (decideWriteFailure(err) === 'revert') {
          setView((prev) => (prev ? mapItem(prev, key, () => before) : prev));
          return;
        }
        setReloadNonce((n) => n + 1);
      })
      .finally(() => {
        if (gen !== genRef.current) return;
        setSavingKeys((prev) => prev.filter((k) => k !== key));
      });
  }, [engine, enabled, apiTarget, host, sessionId, scope]);

  const onSet = useCallback((key: string, value: EngineSettingValue) => {
    runPatch(key, { set: { [key]: value } }, (prev) => optimisticSet(prev, value));
  }, [runPatch]);

  const onReset = useCallback((key: string) => {
    runPatch(key, { unset: [key] }, (prev) => optimisticReset(prev));
  }, [runPatch]);

  const reload = useCallback(() => { setReloadNonce((n) => n + 1); }, []);
  const dismissBanner = useCallback(() => { setBanner(null); }, []);
  const clearLastWrite = useCallback(() => { setLastWrite(null); }, []);

  // A view or error that belongs to a target the render has already left must
  // not paint for the one frame before the effect catches up.
  const fresh = enabled && identity !== '' && identityRef.current === identity;
  const shownView = fresh ? view : null;
  const shownError = fresh ? loadError : null;
  const active = enabled && !!engine;

  return {
    view: shownView,
    loading: active && shownView === null && shownError === null,
    refreshing: active && inFlight && shownView !== null,
    loadError: shownError,
    banner,
    dismissBanner,
    savingKeys,
    lastWrite,
    clearLastWrite,
    onSet,
    onReset,
    reload,
  };
}
