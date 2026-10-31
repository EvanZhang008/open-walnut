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
import { StreamingBlockView } from './StreamingBlockView';

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
  return (
    <>
      {p.turns.map((t, i) => (
        <div key={t.user.msgId ?? t.user.walnutMessageId} className="thread-card-turn">
          <QuestionBubble message={t.user} cwd={h.sessionCwd} />
          {t.replies.map((r) => (r === p.supersededReply ? null : (
            <SessionMessage
              key={r.msgId ?? r.walnutMessageId} message={r} sessionId={h.sessionId} sessionCwd={h.sessionCwd}
              sessionHost={h.sessionHost} answerOnly onTaskClick={h.onTaskClick} onSessionClick={h.onSessionClick} onFileOpen={h.onFileOpen}
            />
          )))}
          {t.replies.length === 0 && !(i === p.turns.length - 1 && p.lastLive) && (
            <div className="thread-card-noanswer">No answer</div>
          )}
        </div>
      ))}
      {p.live && <LiveAnswer key={`live-${p.live.index}`} live={p.live} streaming={p.streaming} h={h} />}
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
