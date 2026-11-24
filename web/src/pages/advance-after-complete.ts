// "Complete and go on" (Settings > Tasks, `ui.next_after_complete`): after a task is completed
// from its column (or with mod+shift+D), the caret goes on to the next task that needs the
// person. It NEVER opens a column: the column the person completed is gone and stays gone, and
// no other task appears in its place (2026-11-24, the user: "I resolve the pannel 2 task and
// then there is one more task appear??? ... it shoud be gone"). The next task's own column, when
// it is already on the strip, takes the caret; otherwise its row in the list does.
//
// The deps carry no way to open a column on purpose: a completion can only move the caret and
// the list's selection (tests/web/advance-after-complete.test.ts holds this file to it).

import type { Task } from '@open-walnut/core';
import { nextNeedsYou } from '@/components/tasks/next-needs-you';
import { resolveTaskSessionId } from '@/utils/session-status';
import type { SessionSlot } from './sessionColumns';

/** What the advance did: the task it went to, and where the caret went for it. */
export interface AdvanceResult {
  task: Task;
  /** The next task's column was already on the strip and takes the caret. Absent: its row
   *  in the list does, and nothing opened. */
  inColumn?: true;
  /** It has no session yet (said on the toast). */
  noSession?: true;
  /** Stop a caret move that has not happened yet (an Undo pressed at once). */
  cancel: () => void;
}

export interface AdvanceInfo {
  taskId: string;
  /** The column that is closing ('' for a completion from the list). */
  sessionId: string;
  queueBefore: string[];
  /** The person moved on meanwhile: the list follows, the caret stays with them. */
  quiet?: boolean;
}

/** The strip column showing `task`'s session, if any (its main, exec, plan or older session). */
export function columnOfTask(task: Task, strip: readonly SessionSlot[]): SessionSlot | undefined {
  return strip.find((c) => c.id === task.session_id || c.id === task.exec_session_id
    || c.id === task.plan_session_id || (task.session_ids?.includes(c.id) ?? false));
}

/** The next task after `doneId` and the column of it already on the strip (never one to open). */
export function pickAdvance(
  queueBefore: readonly string[],
  doneId: string,
  tasks: readonly Task[],
  strip: readonly SessionSlot[],
  closing: string,
): { task: Task; columnId?: string } | null {
  const next = nextNeedsYou(queueBefore, doneId, tasks);
  if (!next) return null;
  const column = columnOfTask(next, strip.filter((c) => c.id !== closing));
  return column ? { task: next, columnId: column.id } : { task: next };
}

export interface AdvanceDeps {
  enabled: () => boolean;
  tasks: () => Task[];
  strip: () => SessionSlot[];
  /** Run once the strip no longer shows the closing column (after-strip.ts). */
  afterStrip: (ready: () => boolean, fn: () => void) => () => void;
  focusColumn: (sessionId: string) => () => void;
  focusRow: (taskId: string) => () => void;
  /** Select the task in the list. */
  locateTask: (taskId: string) => void;
  movedSince: (at: number) => boolean;
  /** The caret is about to move by the keys' doing (useHomeKeyboard.noteKeyboardMove). */
  noteMove: () => void;
  /** Drop a caret request pending from the column that closes. */
  dropPendingFocus: () => void;
  now: () => number;
}

export function makeAdvance(d: AdvanceDeps): (info: AdvanceInfo) => AdvanceResult | null {
  return ({ taskId, sessionId: closing, queueBefore, quiet }) => {
    if (!d.enabled()) return null;
    const picked = pickAdvance(queueBefore, taskId, d.tasks(), d.strip(), closing);
    if (!picked) return null;
    const { task, columnId } = picked;
    if (closing) d.dropPendingFocus();
    if (!quiet) d.noteMove();
    const asked = d.now();
    let cancelFocus = () => {};
    const cancelWait = d.afterStrip(() => !closing || !d.strip().some((c) => c.id === closing), () => {
      d.locateTask(task.id);
      // The person may have gone somewhere while the closing column faded (a jump): theirs.
      if (quiet || d.movedSince(asked)) return;
      cancelFocus = columnId && d.strip().some((c) => c.id === columnId) ? d.focusColumn(columnId) : d.focusRow(task.id);
    });
    return {
      task,
      cancel: () => { cancelWait(); cancelFocus(); },
      ...(columnId ? { inColumn: true as const } : {}),
      ...(resolveTaskSessionId(task) ? {} : { noSession: true as const }),
    };
  };
}

