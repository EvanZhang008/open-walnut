/**
 * A Board card's status chip from its task's own open threads (experiment brief_off): the thread
 * state (needs > read > working > waiting, core/org/thread-groups.ts threadStateOf) in place of a
 * quieter status of the card's own. What the card knows for a fact now stays: a live prompt, a
 * failed session, a hand back, a stuck task, its own ask, a running turn, a worker below asking,
 * a completed task, a red signal on its Board, its own wait (and until when), a stop, an open turn.
 * A thread state never outranks the card's own status either (a waiting thread does not hide a
 * Needs you), and a task with no open thread keeps its status. Pure.
 */
import { THREAD_GROUP_LABELS, type TaskThreadState } from '@open-walnut/thread-groups';
import type { KanbanStatus, KanbanTone } from './kanban-card-model';

const TONE: Record<TaskThreadState['state'], KanbanTone> = { needs: 'red', read: 'red', working: 'green', waiting: 'grey', done: 'green' };
/** The card's own facts now: they outrank any status, a thread's too. */
const FACT_KINDS: ReadonlySet<KanbanStatus['kind']> = new Set([
  'question', 'plan', 'permission', 'error', 'handed-back', 'stuck', 'needs', 'running', 'worker-below', 'done',
  'board-signal', 'waiting', 'waiting-until', 'stopped', 'still-open',
]);
const THREAD_RANK: Record<TaskThreadState['state'], number> = { needs: 3, read: 3, working: 2, waiting: 1, done: 0 };
/** How much a card's own status asks of him: red asks, green moves, the rest waits. */
function ownRank(s: KanbanStatus): number {
  if (s.tone === 'red') return 3;
  if (s.tone === 'green') return 2;
  return 1;
}

export function threadCardStatus(own: KanbanStatus, thread: TaskThreadState | undefined): KanbanStatus {
  if (!thread || thread.state === 'done' || FACT_KINDS.has(own.kind) || THREAD_RANK[thread.state] < ownRank(own)) return own;
  const text = `${THREAD_GROUP_LABELS[thread.state]}: ${thread.title}`;
  return { text, tone: TONE[thread.state], kind: thread.state === 'read' ? 'to-read' : 'thread', tooltip: `${text}\nFrom its thread` };
}
