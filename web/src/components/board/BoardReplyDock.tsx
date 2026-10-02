/**
 * The Board's reply box: Walnut's own chat composer (ChatInput, with its send
 * button and voice input), docked at the bottom of the Board pane under the
 * frame. A thread's "Reply…" field in the frame asks for it (`wn-board:compose`);
 * the frame cannot host the composer itself (sandboxed, opaque origin, no
 * microphone). The draft is per board and thread, so it survives a re-rendered
 * board, a closed dock and a reload; Send posts to that thread.
 */
import { useCallback, useState, type KeyboardEvent } from 'react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { ImageAttachment } from '@/api/chat';

export interface BoardReplyTarget {
  thread: string;
  title: string;
  /** The task the thread is about, by title, when the thread names one. */
  aboutTitle?: string;
}

export interface BoardReplyDockProps {
  boardTaskId: string;
  target: BoardReplyTarget;
  /** Bumped each time a thread asks for the box: focus it again. */
  focusNonce: number;
  /** Resolves to null when stored, else the reason it was not. */
  onSend: (thread: string, text: string) => Promise<string | null>;
  onClose: () => void;
}

/** Where a thread's unsent reply lives (localStorage, ChatInput's own draft store). */
export function boardReplyDraftKey(boardTaskId: string, thread: string): string {
  return `draft:board:${boardTaskId}:${thread}`;
}

export function BoardReplyDock({ boardTaskId, target, focusNonce, onSend, onClose }: BoardReplyDockProps) {
  const [error, setError] = useState<string | null>(null);
  const { thread, title, aboutTitle } = target;

  const send = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean> => {
    if (images?.length) { setError('A board thread takes text only. Remove the image to send.'); return false; }
    const body = text.trim();
    if (!body) return false;
    setError(null);
    const failed = await onSend(thread, body);
    if (failed) setError(failed);
    return !failed;
  }, [onSend, thread]);

  // Escape closes the box, unless the composer used it (a palette or a menu closing).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); }
  };

  return (
    <div className="task-board-dock" data-testid="board-reply-dock" data-thread={thread} onKeyDown={onKeyDown}>
      <div className="task-board-dock-head">
        <span className="task-board-dock-title" data-testid="board-reply-title">
          Reply in <b>{title || thread}</b>{aboutTitle ? <> about <b>{aboutTitle}</b></> : null}
        </span>
        {error && <span className="task-board-dock-error" role="alert">{error}</span>}
        <button
          type="button"
          className="task-board-dock-close"
          onClick={onClose}
          aria-label="Close the reply box"
          title="Close (Esc). The draft is kept."
          data-testid="board-reply-close"
        >×</button>
      </div>
      <ChatInput
        key={`${boardTaskId}:${thread}`}
        draftKey={boardReplyDraftKey(boardTaskId, thread)}
        onSend={send}
        showCommands={false}
        focusNonce={focusNonce}
        placeholder={`Reply in ${title || thread}. It goes to the leader.`}
        sendTitle="Send to the thread"
      />
    </div>
  );
}
