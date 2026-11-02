/**
 * A hand-back never carries an empty sentence (2026-11-01, Main's reflection: a task handed back
 * with no report of its own read "Its turn ended and handed the task back to you: read it and
 * reply.", and what it said was found only by opening the task). When a task's turn ended with no
 * current report, Walnut reads where its last turn stopped (its last message, from the transcript,
 * the same read a request's notice quotes) and keeps it on the task as `last_words`; the status
 * (nothing asked, ToRead `turn`, 2026-11-02) then carries those words.
 *
 * A live idle session is still asked for its report by the reconcile loop (status-reconcile.ts),
 * whose answer wins; this covers what that loop cannot ask (a stopped session, an ACP engine, a
 * Personal AI chat lane, an answer that never reads). Runs in the same tick, a few tasks a pass,
 * never waking a session.
 */
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import type { NoticeLastMessage } from '../session-requests.js';
import { TURN_TO_READ } from '../user-status.js';

export interface LastWords {
  /** Its last message, as plain text and cut to the part a status line can show. */
  text: string;
  /** When Walnut read it: words read before the task's latest phase move describe an older turn. */
  at: string;
  session_id: string;
}

/** How much of the last message the ask shows: its end, where a turn puts its question. */
export const LAST_WORDS_MAX = 240;
const PER_PASS = 6;
/** A task whose read found nothing is not read again for this long. */
const RETRY_GAP_MS = 30 * 60_000;
/** Words read this close before the phase move belong to the turn that made it. */
const SLACK_MS = 60_000;

const lastRead = new Map<string, number>();

/** The last message as one plain line, its end kept (a turn ends with its question). Pure. */
export function lastWordsText(words: NoticeLastMessage | undefined): string {
  if (!words) return '';
  const plain = words.text
    .replace(/<walnut-turn[^>]*\/>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = plain || (words.actions?.length ? `Its last step: ${words.actions[words.actions.length - 1]}` : '');
  if (text.length <= LAST_WORDS_MAX) return text;
  const tail = text.slice(-LAST_WORDS_MAX);
  // Start at a sentence or word boundary inside the tail.
  const cut = tail.search(/(?<=[.!?。！？])\s*\S|\s\S/);
  return `…${(cut > 0 && cut < LAST_WORDS_MAX / 2 ? tail.slice(cut) : tail).trim()}`;
}

/** The words of the task's latest hand-back, when Walnut has read them since it moved. Pure. */
export function currentLastWords(task: Pick<Task, 'phase_changed_at'> & { last_words?: LastWords | null }): string | null {
  const lw = task.last_words;
  if (!lw?.text) return null;
  const moved = Date.parse(task.phase_changed_at ?? '');
  return !Number.isFinite(moved) || Date.parse(lw.at) >= moved - SLACK_MS ? lw.text : null;
}

/** Whether the task's status is the bare hand-back and Walnut has no words of it yet. Pure. */
export function wantsLastWords(task: Task, nowMs: number): boolean {
  if (task.phase !== 'NEED_ACTION' || task.plugin_only || task.org_role) return false;
  if (task.user_status?.toRead !== 'turn' || task.user_status.waitingOn !== TURN_TO_READ) return false;
  if (currentLastWords(task)) return false;
  const last = lastRead.get(task.id);
  return last === undefined || nowMs - last >= RETRY_GAP_MS;
}

/** The session whose last turn the hand-back is about: the task's slot, else its newest. */
function sessionOf(task: Task, sessions: readonly SessionRecord[]): SessionRecord | undefined {
  // A Personal AI chat lane too: it reports no status of its own, so its words are all there is.
  const own = sessions.filter((s) => s.taskId === task.id && !s.archived && s.provider !== 'embedded');
  return own.find((s) => s.claudeSessionId === task.session_id)
    ?? own.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
}

/** One pass. Returns the task ids it stored words for. Exported for tests (`read` stands in for the transcript). */
export async function runLastWordsPass(
  nowMs = Date.now(),
  read: (sessionId: string) => Promise<NoticeLastMessage | undefined> = async (sid) => (await import('./session-request-notify.js')).readLastWords(sid),
): Promise<string[]> {
  const stored: string[] = [];
  try {
    const { listTasks, updateTaskRaw } = await import('../task-manager.js');
    const due = (await listTasks()).filter((t) => wantsLastWords(t, nowMs)).slice(0, PER_PASS);
    if (!due.length) return stored;
    const { listSessionsForTasks } = await import('../session-tracker.js');
    const sessions = await listSessionsForTasks(new Set(due.map((t) => t.id)));
    for (const task of due) {
      if (lastRead.size > 2000) lastRead.clear();
      lastRead.set(task.id, nowMs);
      const s = sessionOf(task, sessions);
      if (!s) continue;
      const text = lastWordsText(await read(s.claudeSessionId).catch(() => undefined));
      if (!text) continue;
      const lastWords: LastWords = { text, at: new Date(nowMs).toISOString(), session_id: s.claudeSessionId };
      await updateTaskRaw(task.id, { last_words: lastWords }, {
        emitEvent: true, push: false, source: 'last-words',
        shouldUpdate: (cur) => cur.phase === 'NEED_ACTION' && cur.phase_changed_at === task.phase_changed_at,
      });
      stored.push(task.id);
      log.task.info('last words: a hand-back with no report reads its last message', { taskId: task.id, sessionId: s.claudeSessionId });
    }
  } catch (err) {
    log.task.warn('last words pass failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return stored;
}

/** Test-only. */
export function __resetLastWords(): void {
  lastRead.clear();
}
