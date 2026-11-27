/**
 * A notice the user can close until what it says changes (kind 1 of the close rule: a state
 * banner or status line). It holds the notice's dismiss state where the notice's condition lives,
 * so the condition and the words are one value: `signature` is what the notice says now, null when
 * it has nothing to say (which forgets what was closed, so the same trouble coming back shows
 * again) and undefined while that is not known yet (the session or its history still loading).
 *
 * Keep it mounted whether or not the notice shows (the condition goes into `signature`, not
 * around this element); only then does it see the null that reopens a closed notice.
 *
 *   <ClosableNotice scope={`session-idle:${sessionId}`} signature={idle ? text : null}>
 *     {(close) => <PanelNotice onClose={close}>{text}</PanelNotice>}
 *   </ClosableNotice>
 */
import type { ReactNode } from 'react';
import { useNoticeDismiss } from '@/utils/notice-dismiss';

export function ClosableNotice({ scope, signature, children }: {
  /** The notice and where it shows: `session-error:<session id>`. */
  scope: string;
  signature: string | null | undefined;
  /** The notice itself, given its close (NoticeClose's onClose). */
  children: (close: () => void) => ReactNode;
}) {
  const { hidden, dismiss } = useNoticeDismiss(scope, signature);
  if (typeof signature !== 'string' || hidden) return null;
  return <>{children(dismiss)}</>;
}
