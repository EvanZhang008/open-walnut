/**
 * Ask the follow-up INSIDE the ✦ card — the small conversation window that lives
 * in the task panel, under the search box.
 *
 * The card already holds the answer, and the button beside it hands the whole
 * conversation to a session column. This is the same conversation without
 * leaving the search box: type a question and the card becomes a small chat.
 *
 * NOTHING new happens server-side. The first follow-up ADOPTS the session the
 * search itself ran in — the same idempotent request the button makes — and the
 * message then rides the ordinary session send path. So the transcript this
 * window shows IS that search's conversation: its first two messages are the
 * folded prompt row and the ✦ answer card, drawn by the same row component as
 * the card above, which is why the card hides its own rows while this is live.
 * Showing both would be the same four rows twice.
 *
 * Two ordering traps this file encodes:
 *  · useSessionSend CLEARS its optimistic rows whenever its session id changes
 *    (it re-reads the server queue for the new session). So the id is put in
 *    state first and the message is sent from an effect: hook effects run in
 *    declaration order, so the clear has already happened when the send adds its
 *    row. Sending before the state landed made the user's own question blink out.
 *  · A second adopt while the first is in flight would send the same question
 *    into the same conversation twice, so the composer is disabled for that beat
 *    and the text is kept — a failure hands it back rather than eating it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { adoptAgentSearchSession } from '@/api/agentSearch';
import { ChatInput } from '@/components/chat/ChatInput';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { useSessionSend } from '@/hooks/useSessionSend';

export function AgentSearchFollowUp({
  query, searchEnabled, progressId, onLive, onOpenTask,
}: {
  /** The search this conversation continues — the adopt key, never a session id. */
  query: string;
  /** May the adopt call RUN a search when none has? The human's own ✦ switch. */
  searchEnabled: boolean;
  /** The card's progress id, so a search this adopt starts still streams here. */
  progressId?: string;
  /** The window went live (or was dismissed): the card hides its rows while it is. */
  onLive: (sessionId: string | null) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [firstMessage, setFirstMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionSend = useSessionSend(sessionId);
  const adoptingRef = useRef(false);
  const sentFirstRef = useRef(false);

  // A DIFFERENT search is a different question: the window closes and the card
  // goes back to showing that search's rows. Nothing is lost — the conversation is
  // a real ask on the board, and the header's button reopens it whole. Keeping it
  // would leave the card labelled for one search while showing another's chat.
  useEffect(() => {
    setSessionId(null);
    setFirstMessage(null);
    setError(null);
    sentFirstRef.current = false;
    onLive(null);
  }, [query, onLive]);

  // Send the first question only once the id is in state — see the header note.
  useEffect(() => {
    if (!sessionId || !firstMessage || sentFirstRef.current) return;
    sentFirstRef.current = true;
    const text = firstMessage;
    setFirstMessage(null);
    void sessionSend.send(sessionId, text).catch(() => { /* the hook shows sendError */ });
  }, [sessionId, firstMessage, sessionSend]);

  /** Resolves false when the question was NOT consumed — the caller hands it back. */
  const submit = useCallback(async (message: string, images?: ImageAttachment[]): Promise<boolean> => {
    const text = message.trim();
    if (!text) return true;
    if (sessionId) {
      void sessionSend.send(sessionId, text, images);
      return true;
    }
    if (adoptingRef.current) return false;
    adoptingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      const adopted = await adoptAgentSearchSession(query, {
        search: searchEnabled,
        ...(progressId ? { progressId } : {}),
      });
      if (!adopted) {
        // Rare: the run aged out and no earlier ask exists. Say so — and the
        // question comes back into the box, because the button beside the header
        // still opens a session the normal way and the words are needed there.
        setError('This search has no conversation to continue yet. Use Open as session.');
        return false;
      }
      setSessionId(adopted.sessionId);
      setFirstMessage(text);
      onLive(adopted.sessionId);
      return true;
    } catch {
      setError('Could not open the conversation. Try again.');
      return false;
    } finally {
      adoptingRef.current = false;
      setOpening(false);
    }
  }, [sessionId, sessionSend, query, searchEnabled, progressId, onLive]);

  // ChatInput clears itself the moment it hands the text over, so a question the
  // submit path could not use has to be put back — losing what someone typed is
  // the one failure this window must not have.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    void submit(message, images).then((consumed) => {
      if (!consumed) setPrefill({ text: message, nonce: Date.now() });
    });
  }, [submit]);

  if (!sessionId) {
    return (
      <div className="agent-search-followup" data-testid="agent-search-followup">
        {error && <div className="agent-search-followup-error" role="alert">{error}</div>}
        <ChatInput
          onSend={handleSend}
          disabled={opening}
          placeholder={opening ? 'Opening this search’s conversation…' : 'Ask a follow-up…'}
          showCommands={false}
          draftKey={`draft:agent-search:${query}`}
          {...(prefill ? { prefillText: prefill.text, prefillNonce: prefill.nonce } : {})}
        />
      </div>
    );
  }

  return (
    <div className="agent-search-followup is-live" data-testid="agent-search-followup">
      <div className="agent-search-followup-history">
        <SessionChatHistory
          sessionId={sessionId}
          optimisticMessages={sessionSend.optimisticMsgs}
          onMessagesDelivered={sessionSend.handleMessagesDelivered}
          onBatchCompleted={sessionSend.handleBatchCompleted}
          onBatchFailed={sessionSend.handleBatchFailed}
          onEditQueued={(queueId, newText) => sessionSend.handleEditQueued(sessionId, queueId, newText)}
          onDeleteQueued={(queueId) => sessionSend.handleDeleteQueued(sessionId, queueId)}
          onAgentQueued={sessionSend.addExternalQueued}
          {...(onOpenTask ? { onTaskClick: onOpenTask } : {})}
        />
      </div>
      <div className="agent-search-followup-input">
        {sessionSend.sendError && (
          <div className="agent-search-followup-error" role="alert">{sessionSend.sendError}</div>
        )}
        <ChatInput
          onSend={(message: string, images?: ImageAttachment[]) => sessionSend.send(sessionId, message, images)}
          placeholder="Ask a follow-up…"
          showCommands={false}
          draftKey={`draft:session:${sessionId}`}
        />
      </div>
    </div>
  );
}
