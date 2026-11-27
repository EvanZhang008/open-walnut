/**
 * Quiet lines of a chat's timeline that carry their own × (every card or notice the user sees can
 * be closed: NoticeClose). Shared by the main chat (ChatMessage) and a session's chat (SessionMessage).
 */
import { useState } from 'react';
import { useRowDisclosure } from '@/components/sessions/row-disclosure';
import { NoticeClose } from '@/components/common/NoticeClose';
import { useNoticeDismiss } from '@/utils/notice-dismiss';

/**
 * "Turn interrupted": the CLI's `[Request interrupted by user]` shown as a muted line, not a "You"
 * bubble. Its × takes the line out of this chat's view; with an id (the row's msgId or its time)
 * it stays out after a reload and in every window.
 */
export function TurnInterruptedRow({ id, time, icon }: { id?: string; time?: string; icon?: boolean }) {
  const [gone, setGone] = useState(false);
  const kept = useNoticeDismiss('chat-interrupt', id);
  if (gone || kept.hidden) return null;
  return (
    <div className="chat-interrupt-banner">
      {icon && <span className="chat-interrupt-icon">{'\u23F9'}</span>}
      <span className="chat-interrupt-text">Turn interrupted</span>
      {time && <span className="chat-interrupt-time">{time}</span>}
      <NoticeClose onClose={() => { setGone(true); kept.dismiss(); }} label="Hide this line" testId="chat-interrupt-close" className="chat-interrupt-close" />
    </div>
  );
}

/**
 * A queued message that was refused when it went out: the reason and Retry. Its × folds the
 * reason away; "Not sent" and Retry stay on the bubble, so it never reads as sent. A new reason
 * shows in full again.
 */
export function SendFailedNote({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  // Keyed by its reason (and remounted per reason by ChatMessage): a new reason opens in full again.
  const [folded, setFolded] = useRowDisclosure(`send-failed:${reason}`, false);
  return (
    <div className={`chat-send-failed${folded ? ' is-folded' : ''}`} role="alert" data-testid="chat-send-failed" title={folded ? reason : undefined}>
      <span className="chat-send-failed-reason">{folded ? 'Not sent' : `Not sent: ${reason}`}</span>
      {onRetry && <button className="btn btn-sm" onClick={onRetry} type="button">Retry</button>}
      {!folded && <NoticeClose onClose={() => setFolded(true)} label="Hide why it was not sent" testId="chat-send-failed-close" />}
    </div>
  );
}
