/**
 * The Board's reply box: Walnut's own chat composer (ChatInput, with its send
 * button and voice input), docked at the bottom of the Board pane under the
 * frame. A thread's "Reply…" field in the frame asks for it (`wn-board:compose`),
 * and so does a choice's "Answer in your own words…"; the frame cannot host the
 * composer itself (sandboxed, opaque origin, no microphone). The draft is per
 * board and thread (or choice), so it survives a re-rendered board, a closed dock
 * and a reload. Send posts to that thread, or saves the words as the choice's
 * answer (beside the pick, if the user made one) and closes the box.
 */
import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { ImageAttachment } from '@/api/chat';

export interface BoardReplyTarget {
  /** The thread the reply goes to; '' when the box answers a choice. */
  thread: string;
  /** The `<walnut-choice>` answered in the user's own words, instead of a thread. */
  choice?: string;
  /** The words already saved on that choice: the box starts from them. */
  text?: string;
  title: string;
  /** The task the thread (or choice) is about, by title, when it names one. */
  aboutTitle?: string;
}

export interface BoardReplyDockProps {
  boardTaskId: string;
  target: BoardReplyTarget;
  /** Bumped each time a thread asks for the box: focus it again. */
  focusNonce: number;
  /** Resolves to null when stored, else the reason it was not. */
  onSend: (thread: string, text: string) => Promise<string | null>;
  /** A choice answered in words: null when saved, else the reason. */
  onAnswer?: (choice: string, text: string) => Promise<string | null>;
  onClose: () => void;
}

/** Where a thread's unsent reply lives (localStorage, ChatInput's own draft store). */
export function boardReplyDraftKey(boardTaskId: string, thread: string): string {
  return `draft:board:${boardTaskId}:${thread}`;
}

/** Where a choice's unsent words live (their own namespace: a thread may share a choice's id). */
export function boardChoiceDraftKey(boardTaskId: string, choice: string): string {
  return `draft:board-choice:${boardTaskId}:${choice}`;
}

/** Mounted once per choice: with no draft of its own, the box starts from the saved words (before ChatInput reads the draft). */
function SeededDraft({ draftKey, text, children }: { draftKey: string; text?: string; children: ReactNode }) {
  useState(() => {
    try { if (text && !localStorage.getItem(draftKey)) localStorage.setItem(draftKey, text); } catch { /* unavailable */ }
    return null;
  });
  return <>{children}</>;
}

export function BoardReplyDock({ boardTaskId, target, focusNonce, onSend, onAnswer, onClose }: BoardReplyDockProps) {
  const [error, setError] = useState<string | null>(null);
  const { thread, choice, title, aboutTitle } = target;
  const answering = !!choice && !!onAnswer;
  const name = title || choice || thread;

  const send = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean> => {
    if (images?.length) {
      setError(answering ? 'An answer takes text only. Remove the image to send.' : 'A board thread takes text only. Remove the image to send.');
      return false;
    }
    const body = text.trim();
    if (!body) return false;
    setError(null);
    const failed = answering ? await onAnswer!(choice!, body) : await onSend(thread, body);
    if (failed) { setError(failed); return false; }
    // An answer is one message: the choice shows it, and the box is done.
    if (answering) onClose();
    return true;
  }, [answering, onAnswer, onSend, onClose, choice, thread]);

  // Escape closes the box, unless the composer used it (a palette or a menu closing).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); }
  };

  const about = aboutTitle ? <> about <b>{aboutTitle}</b></> : null;
  const draftKey = answering ? boardChoiceDraftKey(boardTaskId, choice!) : boardReplyDraftKey(boardTaskId, thread);
  return (
    <div
      className="task-board-dock"
      data-testid="board-reply-dock"
      data-thread={answering ? undefined : thread}
      data-choice={answering ? choice : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="task-board-dock-head">
        <span className="task-board-dock-title" data-testid="board-reply-title">
          {answering ? <>Answer <b>{name}</b> in your own words{about}</> : <>Reply in <b>{name}</b>{about}</>}
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
      <SeededDraft key={draftKey} draftKey={draftKey} text={answering ? target.text : undefined}>
        <ChatInput
          key={draftKey}
          draftKey={draftKey}
          onSend={send}
          showCommands={false}
          focusNonce={focusNonce}
          placeholder={answering
            ? `Your answer to ${name}. It goes to the leader, with your pick if you made one.`
            : `Reply in ${name}. It goes to the leader.`}
          sendTitle={answering ? 'Send your answer' : 'Send to the thread'}
        />
      </SeededDraft>
    </div>
  );
}
