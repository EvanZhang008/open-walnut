/**
 * A question's conversation inside its card, drawn the way the chat draws it
 * (2026-10-27, the user: "the chat from user is like walnut is blue bubble"):
 * each question is the chat's blue user bubble, each answer a normal assistant
 * message with the same markdown, code blocks and streaming. Rounds follow in
 * order. The comment card (beside the passage, and in the Files tab) uses it;
 * so does every fullscreen review card, under its head (ThreadReviewSidebar).
 *
 * Rows never carry `data-message-id`: the marks find their passage by that
 * attribute (`bodyForMsgId`), and a copy here would be found first. Each
 * question sits in `.thread-card-q` (tests and the fold read it).
 */
import { memo, useMemo } from 'react';
import { typedUserText } from '@open-walnut/history-injected-banner';
import type { SessionHistoryMessage } from '@/types/session';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import type { CardTurn } from '@/utils/thread-card';
import { questionBodyOf } from '@/utils/thread-card';
import { SessionMessage, StableMarkdownBody } from './SessionMessage';
import { StreamingBlockView, StreamingReplyMeta, useStreamReplyRows } from './StreamingBlockView';

interface RowHandlers {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

/** The question as the user typed it, without the anchor lines it was sent
 *  with: the chat's blue bubble and the same plain markdown the chat gives a
 *  person's words (StableMarkdownBody, memoized by its text). No hover strip:
 *  the card is not where a message is pinned or rewound. */
const QuestionBubble = memo(function QuestionBubble({ message, cwd }: { message: SessionHistoryMessage; cwd?: string }) {
  const text = useMemo(() => questionBodyOf(typedUserText(message.text ?? '')), [message.text]);
  return (
    <div className="thread-card-q">
      <div className="session-msg session-msg-user">
        <div className="session-msg-content"><StableMarkdownBody text={text} cwd={cwd} /></div>
      </div>
    </div>
  );
});

type LiveText = { index: number; block: StreamingBlock };

/** One live text block, as the chat's assistant message. */
function LiveAnswer({ live, streaming, h }: { live: LiveText; streaming: boolean; h: RowHandlers }) {
  return (
    <div className="session-msg session-msg-assistant">
      <div className="session-msg-content">
        <StreamingBlockView
          block={live.block} sessionId={h.sessionId} sessionCwd={h.sessionCwd} sessionHost={h.sessionHost}
          live={streaming} onTaskClick={h.onTaskClick} onSessionClick={h.onSessionClick} onFileOpen={h.onFileOpen}
        />
        {/* The persisted reply's strip, so the handover adds nothing under it. */}
        {live.block.type === 'text' && <StreamingReplyMeta block={live.block} alwaysVisible={false} />}
      </div>
    </div>
  );
}

export interface ThreadCardConversationProps extends RowHandlers {
  turns: CardTurn<SessionHistoryMessage>[];
  /** The newest turn's persisted reply, hidden while its live block replaces it. */
  supersededReply?: SessionHistoryMessage;
  /** The newest turn may still be answering (no "No answer" for it). */
  lastLive: boolean;
  /** The newest question has no answer yet and did not fail (a strict question
   *  waiting for its tag): its turn says it waits, never "No answer". */
  awaiting?: boolean;
  /** Sent, not in the transcript yet, in the chat's order: each question with
   *  the newest live text answering it (web/src/stream/chat-order.ts). */
  rounds: Array<{ bubble: SessionHistoryMessage & { queueId: string; status: string }; live?: LiveText }>;
  /** Live text answering the newest persisted turn (before any round). */
  live?: LiveText;
  streaming: boolean;
  /** Nothing to show at all. */
  empty: boolean;
}

export const ThreadCardConversation = memo(function ThreadCardConversation(p: ThreadCardConversationProps) {
  const h: RowHandlers = useMemo(() => ({
    sessionId: p.sessionId, sessionCwd: p.sessionCwd, sessionHost: p.sessionHost,
    onTaskClick: p.onTaskClick, onSessionClick: p.onSessionClick, onFileOpen: p.onFileOpen,
  }), [p.sessionId, p.sessionCwd, p.sessionHost, p.onTaskClick, p.onSessionClick, p.onFileOpen]);
  const replyRow = useStreamReplyRows();
  // The live answer to the newest turn is drawn as the reply its persisted
  // twin will be, under the twin's key, in its turn: the twin takes over that
  // element and nothing is built again (a script block keeps running).
  const liveReplyId = p.live?.block.type === 'text' && p.turns.length > 0 ? p.live.block.msgId : undefined;
  const liveReply = p.live && liveReplyId && p.live.block.type === 'text'
    && !p.turns[p.turns.length - 1].replies.some((r) => r !== p.supersededReply && r.msgId === liveReplyId)
    ? replyRow(p.live.block, liveReplyId) : undefined;
  const reply = (r: SessionHistoryMessage) => (
    <SessionMessage
      key={r.msgId ?? r.walnutMessageId} message={r} sessionId={h.sessionId} sessionCwd={h.sessionCwd}
      sessionHost={h.sessionHost} answerOnly onTaskClick={h.onTaskClick} onSessionClick={h.onSessionClick} onFileOpen={h.onFileOpen}
    />
  );
  return (
    <>
      {p.turns.map((t, i) => {
        const last = i === p.turns.length - 1;
        // One children array for the stored replies and the live one, so the
        // stored twin is the same keyed element the live reply was.
        const replies = t.replies.filter((r) => r !== p.supersededReply);
        if (liveReply && last) replies.push(liveReply);
        return (
          <div key={t.user.msgId ?? t.user.walnutMessageId} className="thread-card-turn">
            <QuestionBubble message={t.user} cwd={h.sessionCwd} />
            {replies.map(reply)}
            {t.replies.length === 0 && last && p.awaiting && !liveReply && !p.live && (
              <div className="thread-card-noanswer" data-awaiting="true">Waiting for its answer…</div>
            )}
            {t.replies.length === 0 && !(last && (liveReply || p.lastLive || p.awaiting)) && (
              <div className="thread-card-noanswer">No answer</div>
            )}
          </div>
        );
      })}
      {p.live && !liveReply && <LiveAnswer key={`live-${p.live.index}`} live={p.live} streaming={p.streaming} h={h} />}
      {p.rounds.map(({ bubble: m, live }) => (
        <div key={`opt-${m.queueId}`} className="thread-card-turn" data-status={m.status}>
          <QuestionBubble message={m} cwd={h.sessionCwd} />
          {live && <LiveAnswer key={`live-${live.index}`} live={live} streaming={p.streaming} h={h} />}
        </div>
      ))}
      {p.empty && <div className="thread-card-empty">No message in this question yet.</div>}
    </>
  );
});
