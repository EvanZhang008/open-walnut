/**
 * The chat column's tabs for one session panel (peek-tabs-model.ts): the own
 * chat plus every task opened beside it. `enabled` is "the panel is full screen"
 * (the Board view is always full screen): only then does a tab other than the own
 * chat take the column. Turning it off hides the tabs without forgetting them, and
 * the set is stored per panel task, so the Board, the full screen, another
 * session in this column and a reload all come back to the same tabs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { log } from '@/utils/log';
import {
  activatePeekTab, closeAllPeekTabs, closeOtherPeekTabs, closePeekTab, openPeekTab,
  peekTabsKey, readPeekTabs, stepPeekTab, writePeekTabs, type PeekTabs,
} from './peek-tabs-model';

export type PeekVia = 'chip' | 'chat' | 'tab' | 'menu' | 'key' | 'escape' | 'close' | 'own-chip';

export interface PeekTabsState {
  tabs: string[];
  /** The active tab, whether or not the column shows it now. */
  active: string | null;
  /** The task the column shows in place of the own chat: the active tab while enabled, else null. */
  shownId: string | null;
  open: (taskId: string, via?: PeekVia) => void;
  activate: (taskId: string | null, via?: PeekVia) => void;
  close: (taskId: string, via?: PeekVia) => void;
  closeOthers: (taskId: string) => void;
  closeAll: () => void;
  /** The tab `delta` places away (own chat included, wrapping). */
  stepTarget: (delta: number) => string | null;
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function usePeekTabs(opts: {
  ownTaskId: string | undefined;
  sessionId: string;
  enabled: boolean;
  /** Called on every open: a collapsed chat column opens again. */
  onReveal: () => void;
}): PeekTabsState {
  const key = peekTabsKey(opts.ownTaskId, opts.sessionId);
  const [state, setState] = useState<{ key: string; tabs: PeekTabs }>(() => ({ key, tabs: readPeekTabs(storage(), key) }));
  // Another panel task (this column moved to another session): its own tabs.
  const current = state.key === key ? state.tabs : readPeekTabs(storage(), key);
  useEffect(() => {
    if (state.key !== key) setState({ key, tabs: readPeekTabs(storage(), key) });
  }, [key, state.key]);

  const latest = useRef({ ...opts, key });
  latest.current = { ...opts, key };
  // The set as last written, so two changes in one event (close, then open) build on each other.
  const live = useRef({ key, tabs: current });
  if (live.current.key !== key || live.current.tabs !== current) live.current = { key, tabs: current };

  const update = useCallback((next: (s: PeekTabs) => PeekTabs, what: string, extra: Record<string, unknown>) => {
    const l = latest.current;
    const before = live.current.key === l.key ? live.current.tabs : readPeekTabs(storage(), l.key);
    const after = next(before);
    if (after === before) return;
    live.current = { key: l.key, tabs: after };
    writePeekTabs(storage(), l.key, after);
    setState({ key: l.key, tabs: after });
    log.info('board', `chat column tab ${what}`, {
      taskId: l.ownTaskId ?? '', sessionId: l.sessionId, active: after.active ?? '', tabs: after.tabs.length, ...extra,
    });
  }, []);

  const activate = useCallback((taskId: string | null, via: PeekVia = 'tab') => {
    update((s) => activatePeekTab(s, taskId), 'switched', { targetTaskId: taskId ?? '', via });
  }, [update]);

  const open = useCallback((taskId: string, via: PeekVia = 'chip') => {
    const l = latest.current;
    l.onReveal();
    if (taskId === l.ownTaskId) { activate(null, 'own-chip'); return; }
    update((s) => openPeekTab(s, taskId, l.ownTaskId), 'opened', { targetTaskId: taskId, via });
  }, [activate, update]);

  const close = useCallback((taskId: string, via: PeekVia = 'close') => {
    update((s) => closePeekTab(s, taskId), 'closed', { targetTaskId: taskId, via });
  }, [update]);

  const closeOthers = useCallback((taskId: string) => {
    update((s) => closeOtherPeekTabs(s, taskId), 'closed others', { targetTaskId: taskId });
  }, [update]);

  const closeAll = useCallback(() => { update(() => closeAllPeekTabs(), 'closed all', {}); }, [update]);

  const stepTarget = useCallback((delta: number) => stepPeekTab(live.current.tabs, delta), []);

  return {
    tabs: current.tabs,
    active: current.active,
    shownId: opts.enabled ? current.active : null,
    open, activate, close, closeOthers, closeAll, stepTarget,
  };
}
