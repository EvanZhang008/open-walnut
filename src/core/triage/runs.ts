/**
 * What happens around one triage run: the bookkeeping nobody inside the session
 * can be trusted to do.
 *
 * Each run is a NEW task and a NEW session (decision D2), so a run has three
 * moments and only the first is visible to the cron engine:
 *
 *   task:created    the batch reached a session → ACKNOWLEDGE the claim, so the
 *                   items it carried are finally dropped from the buffer. Before
 *                   this point a crash re-delivers them (at-least-once).
 *   session:result  the run finished → mark its task COMPLETE, append the run's
 *                   line to the journal note, record the outcome on the routine's
 *                   card, and CHECK that State.md was rewritten.
 *   session:error   the same, recorded as a failure.
 *
 * WHY THE TASK GOES COMPLETE. A triage run's task is a run record, not work the
 * human owes anything on. Left at NEED_ACTION every run would add a row to the
 * board that means "read your letters", which the letters already say. The thing
 * a human reads is the letters; the thing they audit is this journal.
 *
 * THE STATE.MD CHECK IS SOFT, AND NEVER RETRIES. The automatic-learning contract
 * is an instruction in the envelope, and an instruction to a model is never the
 * guarantee (the same rule the hook system encodes: inject is advice, deny is the
 * rule). So a run that did not rewrite State.md gets a WARN and a line at the top
 * of the NEXT envelope, and that is all: re-running a session that already sent
 * letters and edited notes would duplicate every one of those side effects.
 *
 * IDENTIFYING A TRIAGE RUN needs no side record: quickStartSession stamps
 * `agent_id` from the launch and the executor files the task under
 * TRIAGE_PROJECT, so the task itself says whose run it is. A side table keyed on
 * task ids would be a second truth that goes stale the moment a task is deleted.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { withFileLock } from '../../utils/file-lock.js';
import { generateNoteId, parseFrontmatter, readId, stampId } from '../parse-frontmatter.js';
import type { Task } from '../types.js';
import { TRIAGE_RUNS_NOTE_DIR, TRIAGE_STATE_NOTE } from './batch.js';
import { TRIAGE_PROJECT } from './bootstrap.js';
import { ackTriageClaim, loadTriageState, markTriageStateStale, recordTriageJournalLine } from './state.js';
import { TRIAGE_AGENT_ID } from './types.js';

/** The ONE subscriber name. Re-subscribing overwrites it. */
export const TRIAGE_RUNS_SUBSCRIBER = 'triage-runs';

/** How many run task ids stay in the hot-path filter. Insertion-ordered FIFO. */
const MAX_TRACKED_RUN_TASKS = 2_000;

// ── Injectable seams ──

export type TriageRunsDeps = {
  getTask?: (id: string) => Promise<Task | undefined>;
  /** The run tasks that already exist, for the one-time seed. */
  listRunTaskIds?: () => Promise<string[]>;
  completeTask?: (id: string) => Promise<void>;
  /** Append one line to the journal note. Defaults to the vault writer below. */
  appendJournal?: (line: string, nowMs: number) => Promise<string>;
  /** Record the run's verdict on the routine's card. */
  recordOutcome?: (entry: JournalOutcome) => Promise<void>;
  /** Withdraw earlier runs' unanswered decision letters. Defaults to the human-inbox helper. */
  withdrawSuperseded?: () => Promise<{ withdrawn: string[]; kept: number; failed: number }>;
  home?: string;
};

async function defaultGetTask(id: string): Promise<Task | undefined> {
  const { getTask } = await import('../task-manager.js');
  try {
    return await getTask(id);
  } catch {
    // Deleted mid-run, or an id from another box's event: not this module's
    // problem, and certainly not a reason to log an error every turn.
    return undefined;
  }
}

async function defaultCompleteTask(id: string): Promise<void> {
  const { updateTask } = await import('../task-manager.js');
  await updateTask(id, { phase: 'COMPLETE' }, { source: 'triage' });
}

/**
 * Take back the decision letters earlier runs left unanswered.
 *
 * WHY AT THE START OF A RUN. A decision letter asks about one item of one batch, and the next batch has
 * looked at that item again: whatever it decided, the old letter's buttons now act on a stale reading, and
 * three per run pile up into a feed rather than a decision list. The withdrawal is announced, so a human
 * mid-read sees it go rather than tapping something that has moved.
 *
 * WHY NO `keepSessionId` IS NEEDED HERE. This runs the instant the NEW run's task appears, before its
 * session has had a turn, so it cannot have sent a letter yet and there is nothing of its own to protect.
 * Anywhere later in a run that would stop being true. The helper only ever touches unanswered
 * `action_required` letters whose sender is a task stamped as a triage run, so an answered decision, a
 * human's own letter and every other agent's letters are left alone.
 */
async function defaultWithdrawSuperseded(): Promise<{ withdrawn: string[]; kept: number; failed: number }> {
  const { withdrawSupersededTriageLetters } = await import('../human-inbox/triage-quota.js');
  return await withdrawSupersededTriageLetters();
}

/**
 * The run tasks that exist right now, by one indexed query on the project.
 *
 * `listTasksSlim` and not `listTasks`: the latter goes through readStore, which
 * CLONES the whole task store on every call. This runs once per process.
 */
async function defaultListRunTaskIds(): Promise<string[]> {
  const { listTasksSlim } = await import('../task-manager.js');
  const rows = await listTasksSlim({ project: TRIAGE_PROJECT });
  return rows.filter((t) => t.agent_id === TRIAGE_AGENT_ID).map((t) => t.id);
}

// ── The journal note ──

/** `Walnut/Triage/Runs/2026-09.md`, vault-relative. */
export function triageRunsNotePath(nowMs: number): string {
  const d = new Date(nowMs);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${TRIAGE_RUNS_NOTE_DIR}/${month}.md`;
}

function runsNoteSkeleton(nowMs: number): string {
  const d = new Date(nowMs);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return [
    '---',
    `id: ${generateNoteId()}`,
    'kind: triage-runs',
    `month: ${month}`,
    '---',
    `# Inbox Triage runs — ${month}`,
    '',
    'One line per run, oldest first. Walnut appends the run itself (when it started,',
    'how many items it carried, which task it ran as, how it ended); the run\'s own',
    'session appends what it decided. Both are kept: a session that dies writes',
    'nothing, and the run still has to be auditable.',
    '',
  ].join('\n');
}

export interface JournalOutcome {
  atMs: number;
  taskId: string;
  taskTitle: string;
  status: 'ok' | 'error';
  durationMs?: number;
  error?: string;
}

/** The one line a run contributes. Pure, so its shape is gradable. */
export function triageJournalLine(outcome: JournalOutcome): string {
  const d = new Date(outcome.atMs);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    + ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const bits = [`- ${stamp} run`, outcome.taskTitle.replace(/\s+/g, ' ').trim() || 'untitled'];
  bits.push(`task ${outcome.taskId.slice(0, 8)}`);
  if (typeof outcome.durationMs === 'number' && outcome.durationMs > 0) {
    bits.push(`${Math.round(outcome.durationMs / 1000)}s`);
  }
  bits.push(outcome.status === 'ok' ? 'ended ok' : `failed: ${(outcome.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 160)}`);
  return bits.join(' · ');
}

/**
 * Append one line to this month's journal note, creating it with its skeleton.
 *
 * Writes the file directly (under the same cross-process lock the notes routes
 * take) and then emits the vault's own NOTES_UPDATED contract, which is what the
 * index reconciler and every open window listen to. Not the HTTP note ops: this
 * runs INSIDE the server, on a bus handler, and an HTTP round trip to itself would
 * queue behind the very request pool the note write is supposed to stay out of.
 */
async function appendToRunsNote(line: string, nowMs: number, home: string): Promise<string> {
  const notePath = triageRunsNotePath(nowMs);
  const file = path.join(home, 'notes', `${notePath}`);
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    let current = '';
    try {
      current = await readFile(file, 'utf-8');
    } catch {
      current = '';
    }
    if (!current.trim()) current = runsNoteSkeleton(nowMs);
    // A note a human created at this path keeps its own frontmatter; only the id
    // is added, exactly as every other note write in the vault does.
    const { data } = parseFrontmatter(current);
    if (!readId(data)) current = stampId(current, generateNoteId());
    const next = `${current.replace(/\s*$/, '')}\n${line}\n`;
    await writeFile(file, next, 'utf-8');
  });
  // `notes/{path-without-.md}` is the shared source contract (api-v1's writeNote,
  // notes-v2's reconcile subscriber, the files tool).
  bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${notePath.replace(/\.md$/, '')}` }, ['web-ui']);
  return notePath;
}

// ── The State.md check ──

/** `updated` from State.md's frontmatter, in ms, or undefined when unreadable. */
export async function readStateUpdatedMs(home: string): Promise<number | undefined> {
  const file = path.join(home, 'notes', TRIAGE_STATE_NOTE);
  let bytes: string;
  try {
    bytes = await readFile(file, 'utf-8');
  } catch {
    return undefined;
  }
  const { data } = parseFrontmatter(bytes);
  const raw = data.updated;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw.trim());
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

// ── Recognising a run ──

/** Is this task one triage run's task? Read off the task, never a side table. */
export function isTriageRunTask(task: Task | undefined | null): boolean {
  if (!task) return false;
  return task.agent_id === TRIAGE_AGENT_ID && task.project === TRIAGE_PROJECT;
}

function createdAtMs(task: Task): number {
  const ms = Date.parse(task.created_at ?? '');
  return Number.isFinite(ms) ? ms : Date.now();
}

// ── The subscriber ──

export type TriageRunsHandle = {
  stop(): void;
  /** Diagnostics + tests. */
  stats(): { handled: number; acked: number; settled: number; known: number };
};

let active: TriageRunsHandle | null = null;

export function startTriageRuns(deps: TriageRunsDeps = {}): TriageRunsHandle {
  active?.stop();

  const home = deps.home ?? WALNUT_HOME;
  const getTask = deps.getTask ?? defaultGetTask;
  const listRunTaskIds = deps.listRunTaskIds ?? defaultListRunTaskIds;
  const completeTask = deps.completeTask ?? defaultCompleteTask;
  const withdrawSuperseded = deps.withdrawSuperseded ?? defaultWithdrawSuperseded;
  const appendJournal = deps.appendJournal
    ?? ((line: string, nowMs: number) => appendToRunsNote(line, nowMs, home));
  const recordOutcome = deps.recordOutcome ?? defaultRecordOutcome;

  let handled = 0;
  let acked = 0;
  let settled = 0;
  let stopped = false;
  /** Tasks already settled in this process — one result per run, not per turn. */
  const settledTasks = new Set<string>();
  /**
   * Known run tasks, so the hot path is a Set lookup.
   *
   * `session:result` fires at the end of EVERY turn of EVERY session on the box,
   * and loading a task goes through readStore, which clones the whole task store.
   * Paying that per turn to discover that a session has nothing to do with triage
   * is exactly the kind of per-event work that starves the one event loop every
   * route shares. So: seed ONCE from the project index, keep it current from
   * `task:created`, and only read a task when its id is in here.
   */
  const runTasks = new Set<string>();
  let seeding: Promise<void> | null = null;

  /** One-time seed. Lazy, so a box that never runs triage never pays for it. */
  function seedRunTasks(): Promise<void> {
    if (!seeding) {
      seeding = listRunTaskIds()
        .then((ids) => { for (const id of ids) runTasks.add(id); })
        .catch((err) => {
          log.cron.warn('triage: could not list existing run tasks — a run started before this process may not be closed out', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return seeding;
  }

  /** Bound the set: a run settles in minutes, so evicting the oldest is safe. */
  function rememberRunTask(id: string): void {
    runTasks.add(id);
    while (runTasks.size > MAX_TRACKED_RUN_TASKS) {
      const oldest = runTasks.values().next();
      if (oldest.done) break;
      runTasks.delete(oldest.value);
    }
  }

  /**
   * The batch reached a session. Acknowledging here rather than on session:result
   * is deliberate: the task existing IS the delivery, and waiting minutes for a
   * result would let the next fire re-deliver a batch that was never lost.
   */
  async function onRunTaskCreated(task: Task): Promise<void> {
    const state = await loadTriageState(home);
    if (!state.claim) return;
    const { acked: ok } = await ackTriageClaim(state.claim.atMs, home);
    if (!ok) return;
    acked += 1;
    log.cron.info('triage: batch acknowledged — the run has a session', {
      taskId: task.id, claimedAtMs: state.claim.atMs,
      mail: state.claim.mail, slack: state.claim.slack,
    });
    // Last, and never allowed to undo the ack: a letter this fails to take back is one stale question in
    // an inbox, while a lost ack is a batch delivered twice.
    try {
      const taken = await withdrawSuperseded();
      if (taken.withdrawn.length || taken.failed) {
        log.cron.info('triage: took back the decisions an earlier run left open', {
          taskId: task.id, withdrawn: taken.withdrawn.length, kept: taken.kept, failed: taken.failed,
        });
      }
    } catch (err) {
      log.cron.warn('triage: could not take back an earlier run\'s decisions', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The run ended. Everything a human or a later run needs, recorded once. */
  async function onRunSettled(
    task: Task,
    outcome: { status: 'ok' | 'error'; error?: string },
  ): Promise<void> {
    if (settledTasks.has(task.id)) return;
    // COMPLETE is terminal, so a task already there was settled by an earlier
    // process (a restart mid-run) and re-doing the journal would duplicate a line.
    if (task.phase === 'COMPLETE') { settledTasks.add(task.id); return; }
    settledTasks.add(task.id);
    settled += 1;

    const startedAtMs = createdAtMs(task);
    const nowMs = Date.now();

    try {
      await completeTask(task.id);
    } catch (err) {
      log.cron.warn('triage: could not complete the run task', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }

    const journal: JournalOutcome = {
      atMs: startedAtMs,
      taskId: task.id,
      taskTitle: task.title ?? '',
      status: outcome.status,
      durationMs: Math.max(0, nowMs - startedAtMs),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    const line = triageJournalLine(journal);
    try {
      const notePath = await appendJournal(line, nowMs);
      await recordTriageJournalLine(line, home);
      log.cron.info('triage: run recorded in the journal', { taskId: task.id, notePath });
    } catch (err) {
      log.cron.warn('triage: journal append failed', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await recordOutcome(journal);
    } catch (err) {
      log.cron.debug('triage: could not record the run outcome on the routine', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }

    // SOFT check, never a retry. A run that did not rewrite State.md still did
    // everything else it did, and re-running it would send its letters twice.
    const updatedMs = await readStateUpdatedMs(home);
    if (updatedMs === undefined || updatedMs < startedAtMs) {
      log.cron.warn('triage: the run did not update State.md — the next envelope will say so', {
        taskId: task.id, startedAtMs, stateUpdatedMs: updatedMs,
      });
      await markTriageStateStale(home);
    }
  }

  function handler(event: BusEvent): void {
    if (stopped) return;
    handled += 1;
    void (async () => {
      try {
        if (event.name === EventNames.TASK_CREATED) {
          const task = (event.data as { task?: Task } | undefined)?.task;
          if (!isTriageRunTask(task)) return;
          rememberRunTask(task!.id);
          await onRunTaskCreated(task!);
          return;
        }
        const data = event.data as {
          taskId?: string; isError?: boolean; result?: string; error?: string;
          teamActive?: boolean; backgroundActive?: boolean; detachedBgActive?: boolean;
        } | undefined;
        const taskId = data?.taskId;
        if (!taskId) return;
        // An intermediate result: a team or a background set is still working, so
        // the turn is not over and calling the run finished would be a lie.
        if (data?.teamActive || data?.backgroundActive || data?.detachedBgActive) return;
        if (settledTasks.has(taskId)) return;
        await seedRunTasks();
        if (!runTasks.has(taskId)) return;
        const task = await getTask(taskId);
        if (!isTriageRunTask(task)) return;
        if (event.name === EventNames.SESSION_ERROR) {
          await onRunSettled(task!, { status: 'error', error: data?.error });
          return;
        }
        await onRunSettled(task!, data?.isError
          ? { status: 'error', error: data?.result }
          : { status: 'ok' });
      } catch (err) {
        log.cron.warn('triage: run bookkeeping failed', {
          event: event.name, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  bus.subscribe(TRIAGE_RUNS_SUBSCRIBER, handler, {
    global: true,
    interest: [EventNames.TASK_CREATED, EventNames.SESSION_RESULT, EventNames.SESSION_ERROR],
  });

  const handle: TriageRunsHandle = {
    stop() {
      stopped = true;
      settledTasks.clear();
      runTasks.clear();
      seeding = null;
      bus.unsubscribe(TRIAGE_RUNS_SUBSCRIBER);
      if (active === handle) active = null;
    },
    stats() {
      return { handled, acked, settled, known: runTasks.size };
    },
  };
  active = handle;
  log.cron.debug('triage: run bookkeeping armed');
  return handle;
}

/**
 * Put the run's verdict on the routine's card.
 *
 * Best effort by design: the routine may have been deleted while the run was
 * still going, and the journal note is the durable record either way.
 */
async function defaultRecordOutcome(outcome: JournalOutcome): Promise<void> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return;
  const { findTriageRoutine } = await import('./bootstrap.js');
  const job = findTriageRoutine(await service.list({ includeDisabled: true }));
  if (!job) return;
  const { auditDelivery } = await import('../cron/trigger-audit.js');
  await service.recordRunOutcome(job.id, {
    atMs: outcome.atMs,
    outcome: 'fired',
    durationMs: outcome.durationMs,
    ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
    delivery: auditDelivery({
      status: outcome.status,
      retry: false,
      // The FULL task id stays in the summary the merge replaces, so this row is
      // still findable by `ref` afterwards (a second outcome, a human grepping).
      summary: `${outcome.taskTitle} (task ${outcome.taskId}) ${outcome.status === 'ok' ? 'ended ok' : 'failed'}`,
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
    // No `injected` on purpose: the dispatch row already holds the batch preview,
    // which is the answer to "what did this run read". Setting it here would
    // replace that with the task title.
    // The task id is how the right row is found: the claude-code executor puts it
    // in the dispatch summary, and two runs a minute apart make "the newest row"
    // the wrong answer.
  }, outcome.taskId);
}

/** Tests only: the live handle. */
export function getTriageRunsHandleForTesting(): TriageRunsHandle | null {
  return active;
}
