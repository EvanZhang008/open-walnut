/**
 * The comments of one document (stores/doc-comments-store.ts) and when to read
 * its comments file again: after the session's agent finished a tool call that
 * writes (debounced, a turn runs many), when the window is looked at again, and on
 * a slow idle tick while the doc is on show.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { READ_ONLY_TOOLS } from '@/utils/embedded-image-freshness';
import { sidecarPathOf, type DocCommentEdit } from '@/utils/doc-comments';
import {
  docCommentsEntry, docCommentsSnapshot, editDocComments, refreshDocComments, subscribeDocComments,
  type DocCommentsSnapshot,
} from '@/stores/doc-comments-store';

/** A turn's tool results come in bursts: one read after the burst settles. */
const TOOL_SETTLE_MS = 1200;
/** Writers we cannot hear (another session, a terminal): a slow tick while on show. */
const IDLE_READ_MS = 12_000;

export interface DocCommentsStore extends DocCommentsSnapshot {
  edit: (e: DocCommentEdit, label: string) => void;
  refresh: () => void;
}

export function useDocComments(opts: { path: string; host?: string; sessionId?: string }): DocCommentsStore {
  const { path, host, sessionId } = opts;
  const entry = useMemo(
    () => docCommentsEntry(sidecarPathOf(path), host, path.slice(path.lastIndexOf('/') + 1)),
    [path, host],
  );
  const snapshot = useSyncExternalStore(
    useCallback((l: () => void) => subscribeDocComments(entry, l), [entry]),
    () => docCommentsSnapshot(entry),
  );
  const refresh = useCallback(() => refreshDocComments(entry), [entry]);
  const edit = useCallback((e: DocCommentEdit, label: string) => editDocComments(entry, e, label), [entry]);
  useEffect(() => { refresh(); }, [refresh]);

  // The agent may have written the file: read after its tool burst settles.
  const writeTools = useRef(new Set<string>());
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEvent('session:tool-use', (data) => {
    const d = data as { sessionId?: string; toolName?: string; toolUseId?: string; replayed?: boolean };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId || d.replayed) return;
    if (d.toolName && READ_ONLY_TOOLS.has(d.toolName)) return;
    writeTools.current.add(d.toolUseId);
  });
  useEvent('session:tool-result', (data) => {
    const d = data as { sessionId?: string; toolUseId?: string };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId || !writeTools.current.delete(d.toolUseId)) return;
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(refresh, TOOL_SETTLE_MS);
  });
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // Looked at again, and the slow tick while on show.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const tick = setInterval(onVisible, IDLE_READ_MS);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
    };
  }, [refresh]);

  return useMemo(() => ({ ...snapshot, edit, refresh }), [snapshot, edit, refresh]);
}
