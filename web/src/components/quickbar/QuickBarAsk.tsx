/**
 * The quick bar's Ask mode (quickbar-modes.ts): a quick question answered in the bar by one fast
 * model call (POST /api/v1/quick/ask: no task, no session), asked again to go on with the same
 * conversation, or made a task, a normal Ask Walnut chat that carries the exchange on.
 */
import { useEffect, useRef, useState } from 'react';
import { quickAsk, startAskTask } from '@/api/quick';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { AgentText } from '@/components/common/AgentText';

/** What one quick question or the chat a task starts with may hold (MAX_TEXT_CHARS, quick-input-v1.ts). */
const ASK_MAX_CHARS = 20_000;

export interface AskTurn { question: string; answer: string; failed?: string; done: boolean }

export function useQuickAsk() {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const conversation = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const ask = useLeanCallback((question: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    // The server keeps a conversation by the key the asker names (src/core/ai/ai-run.ts echoes it
    // back, never makes one): the bar names it on the first question, the next ones go on with it.
    // (Not crypto.randomUUID: a page served over plain http off this machine has none.)
    conversation.current ??= `quickbar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // A question asked before the last answer came stops waiting for it.
    setTurns((all) => [...all.map((t) => (t.done ? t : { ...t, done: true, failed: t.answer ? undefined : 'Stopped: asked again.' })), { question, answer: '', done: false }]);
    const update = (fn: (t: AskTurn) => AskTurn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));
    void quickAsk(question.slice(0, ASK_MAX_CHARS), conversation.current, (line) => {
      if (line.type === 'text') update((t) => ({ ...t, answer: t.answer + line.delta }));
      else if (line.type === 'result') {
        if (line.conversation) conversation.current = line.conversation;
        update((t) => ({ ...t, answer: line.text || t.answer, done: true }));
      } else update((t) => ({ ...t, failed: line.message, done: true }));
    }, ctl.signal).finally(() => { if (!ctl.signal.aborted) update((t) => ({ ...t, done: true })); });
  }, []);

  const reset = useLeanCallback(() => {
    abort.current?.abort();
    conversation.current = null;
    setTurns([]);
  }, []);

  useEffect(() => () => abort.current?.abort(), []);
  return { turns, ask, reset };
}

/** The exchange as one message, for the chat a task starts with. */
export function askTranscript(turns: readonly AskTurn[]): string {
  const lines = turns.flatMap((t) => [`Q: ${t.question}`, t.answer ? `A: ${t.answer.trim()}` : '']).filter(Boolean);
  const tail = '\n\n(From a quick question in the quick bar: carry it on from here.)';
  // The newest exchange matters most: a long one keeps its end.
  const body = lines.join('\n\n');
  return (body.length + tail.length > ASK_MAX_CHARS ? `\u2026${body.slice(body.length - (ASK_MAX_CHARS - tail.length - 1))}` : body) + tail;
}

export function QuickBarAsk({ turns, onTask }: { turns: readonly AskTurn[]; onTask: (taskId: string) => void }) {
  const [making, setMaking] = useState<'idle' | 'making' | string>('idle');
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [turns]);

  const makeTask = useLeanCallback(() => {
    setMaking('making');
    startAskTask(askTranscript(turns)).then((taskId) => { setMaking('idle'); onTask(taskId); })
      .catch((err: unknown) => setMaking(err instanceof Error ? err.message : 'Not started.'));
  }, [turns, onTask]);

  if (turns.length === 0) return <div className="qb-ask qb-ask-empty">A quick answer here, with no task made. Ask again to go on.</div>;
  const last = turns[turns.length - 1];
  return (
    <div className="qb-ask" data-testid="qb-ask">
      <div className="qb-ask-turns">
        {turns.map((t, i) => (
          <div key={i} className="qb-ask-turn">
            <div className="qb-ask-q">{t.question}</div>
            {t.failed
              ? <div className="qb-ask-a qb-ask-failed" role="status">{t.failed}</div>
              : t.answer ? <AgentText text={t.answer} className="qb-ask-a" task={null} compact /> : <div className="qb-ask-a">{t.done ? '' : 'Thinking…'}</div>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {last.done && (
        <div className="qb-ask-actions">
          <button type="button" className="qb-btn" onClick={makeTask} disabled={making === 'making'} data-testid="qb-ask-task">
            {making === 'making' ? 'Making a task…' : 'Make it a task'}
          </button>
          {making !== 'idle' && making !== 'making' && <span className="qb-ask-failed" role="status">{making}</span>}
        </div>
      )}
    </div>
  );
}
