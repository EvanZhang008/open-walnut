/**
 * The two buttons beside a sessionless card's `No session` (spec 7.6, G15):
 * `Start worker` starts the card's task through the task start the Draft
 * column uses (quick-start with the task's id), on the leader's host and in
 * the leader's folder; the board never starts a session on its own.
 * `Tell the leader` sends the leader's session one line naming the card
 * (`New ticket card <full id> "<title>" in <lane>. Pick it up or start a
 * worker.`) through the same send path as its composer; it is aria-disabled
 * when the leader has no session. Both read only while in flight and say why
 * they failed.
 */
import { useState } from 'react';
import { fetchSession, quickStartSession } from '@/api/sessions';
import { log } from '@/utils/log';
import type { KanbanCardStartProps } from './kanban-contract';
import { sendToCardSession } from './KanbanCardComposer';

export const NO_LEADER_SESSION_TITLE = 'The leader has no session';

/** What `Tell the leader` sends. */
export function tellLeaderText(taskId: string, title: string, laneName: string): string {
  return `New ticket card ${taskId} "${title}" in ${laneName}. Pick it up or start a worker.`;
}

/** The first message a started worker gets. */
export function startWorkerText(title: string): string {
  return `Work on this task: ${title}`;
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.trim() || 'the server did not answer';
}

export function KanbanCardStart({ card, leader, laneName }: KanbanCardStartProps) {
  const [busy, setBusy] = useState<'' | 'start' | 'tell'>('');
  const [error, setError] = useState('');
  const [told, setTold] = useState(false);
  const leaderSid = leader.sessionId;

  const start = async () => {
    if (busy) return;
    if (!leaderSid) { setError(`Couldn't start: ${NO_LEADER_SESSION_TITLE.toLowerCase()} to take a folder from`); return; }
    setBusy('start');
    setError('');
    try {
      const lead = await fetchSession(leaderSid);
      if (!lead?.cwd) throw new Error("the leader's session has no folder");
      const res = await quickStartSession({
        cwd: lead.cwd, ...(lead.host ? { host: lead.host } : {}), message: startWorkerText(card.title), taskId: card.taskId,
      });
      log.info('board', 'kanban worker started', { cardTaskId: card.taskId, sessionId: res.sessionId ?? '', leaderSessionId: leaderSid, host: lead.host ?? '' });
    } catch (err) {
      log.warn('board', 'kanban worker start failed', { cardTaskId: card.taskId, error: String(err) });
      setError(`Couldn't start: ${reasonOf(err)}`);
    } finally {
      setBusy('');
    }
  };

  const tell = async () => {
    if (busy || !leaderSid) return;
    setBusy('tell');
    setError('');
    try {
      await sendToCardSession(leaderSid, tellLeaderText(card.taskId, card.title, laneName));
      log.info('board', 'kanban card told the leader', { cardTaskId: card.taskId, leaderSessionId: leaderSid });
      setTold(true);
      setTimeout(() => setTold(false), 2_000);
    } catch (err) {
      log.warn('board', 'kanban tell leader failed', { cardTaskId: card.taskId, error: String(err) });
      setError(`Couldn't tell the leader: ${reasonOf(err)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <span className="kanban-card-start-bar" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="kanban-text-btn"
        data-testid="kanban-card-start"
        aria-busy={busy === 'start' || undefined}
        aria-disabled={busy ? true : undefined}
        title={`Start a worker session on this task in ${leader.title}'s folder`}
        onClick={() => void start()}
      >{busy === 'start' ? 'Starting...' : 'Start worker'}</button>
      <button
        type="button"
        className="kanban-text-btn"
        data-testid="kanban-card-tell-leader"
        aria-disabled={!leaderSid || !!busy || undefined}
        title={leaderSid ? 'Tell the leader about this card' : NO_LEADER_SESSION_TITLE}
        onClick={() => void tell()}
      >{told ? 'Told the leader' : busy === 'tell' ? 'Telling...' : 'Tell the leader'}</button>
      {error && <span className="kanban-card-start-error" data-testid="kanban-card-start-error" role="alert">{error}</span>}
    </span>
  );
}
