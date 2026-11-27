/**
 * The × of the notices a session panel draws itself (SessionPanel.tsx: its error, the idle auto-stop,
 * "returned empty", the Auto-mode refusal, the folder that is gone). Each is a state notice (kind 1 of
 * the close rule): closed, it stays hidden until what it says changes, and once the state clears
 * (signature null) a later return of the same trouble shows again. While the session or its history
 * is still loading the signature is undefined, so a reload never forgets what was closed.
 *
 * Scoped per session: closing one session's error leaves every other session's as it is.
 */
import { useNoticeDismiss } from '@/utils/notice-dismiss';
import type { SessionRecord } from '@/types/session';

type Sig = string | null | undefined;

export interface PanelNoticeFacts {
  session: Pick<SessionRecord, 'process_status' | 'errorMessage' | 'activity' | 'archived' | 'mode' | 'autoPermissionDenial' | 'cwdGone'> | null | undefined;
  /** The host re-check proved the host reachable while the record blames it (the "not running" sentence). */
  provedReachable: boolean;
  historyLoading: boolean;
  /** The history has user messages and no assistant reply and no error row (the "returned empty" rule). */
  returnedEmpty: boolean;
}

/** What each notice says now, as its close signature. Exported for tests. */
export function panelNoticeSignatures(f: PanelNoticeFacts): { error: Sig; idle: Sig; empty: Sig; denial: Sig; folderGone: Sig } {
  const s = f.session;
  if (!s) return { error: undefined, idle: undefined, empty: undefined, denial: undefined, folderGone: undefined };
  const ps = s.process_status;
  const reconnecting = !!s.errorMessage?.includes('Connection lost') && !!s.activity?.includes('Reconnecting');
  const idleMin = ps === 'stopped' ? s.errorMessage?.match(/^No output for (\d+) min$/i)?.[1] : undefined;
  return {
    error: ps === 'error' ? `${reconnecting ? 'reconnecting' : f.provedReachable ? 'reachable' : 'error'}:${s.errorMessage ?? ''}` : null,
    idle: idleMin ? `idle:${idleMin}` : null,
    empty: f.historyLoading ? undefined : (ps === 'stopped' || ps === 'error') && !s.archived && f.returnedEmpty ? 'empty' : null,
    denial: s.mode === 'auto' && s.autoPermissionDenial ? `${s.autoPermissionDenial.at}:${s.autoPermissionDenial.tools.join(',')}` : null,
    folderGone: s.cwdGone && !s.archived ? s.cwdGone.cwd : null,
  };
}

export function useSessionPanelCloses(sessionId: string, facts: PanelNoticeFacts) {
  const sig = panelNoticeSignatures(facts);
  return {
    error: useNoticeDismiss(`session-error:${sessionId}`, sig.error),
    idle: useNoticeDismiss(`session-idle:${sessionId}`, sig.idle),
    empty: useNoticeDismiss(`session-empty:${sessionId}`, sig.empty),
    denial: useNoticeDismiss(`session-auto-denial:${sessionId}`, sig.denial),
    folderGone: useNoticeDismiss(`session-folder-gone:${sessionId}`, sig.folderGone),
  };
}
