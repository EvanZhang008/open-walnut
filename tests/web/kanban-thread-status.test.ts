/**
 * A Board card's status chip reads its task's own open threads with the Brief off (experiment
 * brief_off, web/src/components/board/kanban/kanban-thread-status.ts): each thread state its own
 * words and tone in place of a quieter status; the card's own facts (a live prompt, a failure, a
 * hand back, its ask, a running turn) stay; a thread never outranks the card's own status; a task
 * with no open thread keeps its status.
 */
import { describe, expect, it } from 'vitest';
import { threadCardStatus } from '../../web/src/components/board/kanban/kanban-thread-status';
import type { KanbanStatus } from '../../web/src/components/board/kanban/kanban-card-model';
import { mkTask, vm, withSession } from './kanban-card-fixtures';

const idle: KanbanStatus = { text: 'Idle 3h', tone: 'amber', kind: 'idle', tooltip: '' };
const turnEnded: KanbanStatus = { text: 'Turn ended', tone: 'green', kind: 'turn-ended', tooltip: '' };
const thread = (state: 'needs' | 'read' | 'working' | 'waiting' | 'done') => ({ state, id: 'th-1', title: 'Pick the seed tray size' });

describe('the chip from the task\'s threads', () => {
  it('names the thread state and the thread, in the words his Threads use', () => {
    expect(threadCardStatus(idle, thread('needs'))).toMatchObject({ text: 'Needs you: Pick the seed tray size', tone: 'red', kind: 'thread' });
    expect(threadCardStatus(idle, thread('read'))).toMatchObject({ text: 'To read: Pick the seed tray size', tone: 'red', kind: 'to-read' });
    expect(threadCardStatus(idle, thread('working'))).toMatchObject({ text: 'Working: Pick the seed tray size', tone: 'green', kind: 'thread' });
    expect(threadCardStatus(idle, thread('waiting'))).toMatchObject({ text: 'Waiting / snoozed: Pick the seed tray size', tone: 'grey' });
  });

  it('the card\'s own facts stay, a thread never outranks its status, and a closed thread is no status', () => {
    for (const kind of ['question', 'plan', 'permission', 'error', 'handed-back', 'stuck', 'needs', 'running', 'worker-below', 'done', 'board-signal', 'waiting', 'waiting-until', 'stopped', 'still-open'] as const) {
      const own: KanbanStatus = { text: 'Own', tone: kind === 'running' ? 'green' : 'red', kind, tooltip: '' };
      expect(threadCardStatus(own, thread('needs')), kind).toBe(own);
    }
    // A waiting thread does not hide a card that moves (green), a working one replaces it.
    expect(threadCardStatus(turnEnded, thread('waiting'))).toBe(turnEnded);
    expect(threadCardStatus(turnEnded, thread('working')).kind).toBe('thread');
    expect(threadCardStatus(idle, thread('done'))).toBe(idle);
    expect(threadCardStatus(idle, undefined)).toBe(idle);
  });

  it('a card built with its task\'s thread state shows it; a running task and a completed one keep their own', () => {
    const t = mkTask({ title: 'Seed trays' });
    expect(vm(t, null, { thread: thread('needs') }).status.text).toBe('Needs you: Pick the seed tray size');
    expect(vm(t, null, { thread: thread('needs') }).needsYou).toBe(true);
    expect(vm(t, null).status.kind).not.toBe('thread');
    const done = vm(mkTask({ phase: 'COMPLETE' }), null, { thread: thread('waiting') });
    expect(done.status.kind).toBe('done');
    const running = withSession({ title: 'Running' });
    const live = { process_status: 'running', sessionId: running.session_id, statusUpdatedAt: new Date().toISOString() } as never;
    expect(vm(running, live, { thread: thread('waiting') }).status.kind).not.toBe('thread');
  });
});
