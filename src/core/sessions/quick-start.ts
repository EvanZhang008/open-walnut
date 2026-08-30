/**
 * Quick-start core — create a task and start a real Claude Code session for it.
 *
 * Extracted from the POST /api/sessions/quick-start handler so non-HTTP callers
 * (the claude-code routine executor) can start sessions through the exact same
 * path: task creation → TASK_CREATED → SESSION_START bus emit → session-runner
 * spawns the CLI (locally or via the remote daemon).
 */

import path from 'node:path';
import { log } from '../../logging/index.js';
import { addTask, getTask, updateTask, getCustomTiers, ensureProject, setProjectMetadata, InvalidProjectNameError, ProjectSourceConflictError } from '../task-manager.js';
import { getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { bus, EventNames } from '../event-bus.js';
import type { Task, SessionEngine } from '../types.js';
import { spillLargePromptToFile } from './quick-start-spill.js';
import { isAcpEngine } from '../agents/engine-registry.js';

export interface QuickStartTaskMeta {
  /** Start the new task already marked unread. */
  unread?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  /**
   * Built-in tier ('focus' | 'satellite' | 'backlog' | 'wait') or a registered
   * custom tier id (ct_*).
   *
   * Three-way: a tier name pins into that tier; `null` is an explicit "do NOT
   * pin this one" (the launcher's unpin gesture); omitted means the caller has
   * no opinion and the new task takes the board default (pinned, Satellite).
   */
  pinTier?: string | null;
  /** Task dates (ISO) — same trio as POST /api/tasks; a launch IS a task create. */
  due_date?: string;
  start_date?: string;
  end_date?: string;
}

export interface QuickStartParams {
  message: string;
  /**
   * Prepended to the (possibly spilled) message — NOT subject to spill.
   * The HTTP route uses this for the attached-images context block, matching
   * the original handler's order: spill first, then prefix.
   */
  messagePrefix?: string;
  cwd: string;
  host?: string;
  model?: string;
  mode?: string;
  /** Retry mode: reuse this task instead of creating a new one. */
  existingTaskId?: string;
  taskMeta?: QuickStartTaskMeta;
  /** Task title; defaults to "Session: <basename(cwd)>". */
  taskTitle?: string;
  /** Task project. Omitted/empty = Inbox; the auto-organize pass below then
   *  offers to file the task under an existing project. */
  project?: string;
  /** `project` was DERIVED from the launch folder (the draft's "a folder is a
   *  project" default) — when this launch CREATES the registry row, the folder is
   *  stamped as its default_cwd so the next pick resolves straight to it. Only
   *  the folder-derived path may claim this; a server-chosen or routine-supplied
   *  project must not adopt whatever directory it happened to first run in. */
  projectFromFolder?: boolean;
  /** Event-bus source tag, e.g. 'quick-start' | 'routine'. */
  source: string;
  requestTs?: number;
  /** Coding-agent engine; defaults to 'claude' (native path). */
  engine?: SessionEngine;
  /**
   * Caller-minted session id, forwarded to the CLI as `--session-id`. Lets the
   * HTTP route return the session id in its response instead of making the UI
   * poll for it — the CLI adopts this id when it spawns. Native (claude) engine
   * only: the ACP path derives its own ids from the adapter.
   */
  preassignedSessionId?: string;
  /**
   * "Ask Walnut" launch (the draft's second tab): the session spawns with the
   * Personal AI's own profile (persona + standing memory + skills index, via
   * personal-ai-lane's buildLaneProfile) instead of as a bare coding agent.
   * Everything else is an ORDINARY quick-start — a normal task, a visible
   * session — the route just pre-fills project 'Ask Walnut' and cwd WALNUT_HOME.
   * Native (claude) engine only: the profile rides --system-prompt, which ACP
   * engines have no channel for (route enforces).
   */
  walnutAgent?: boolean;
}

export class QuickStartError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'QuickStartError';
  }
}

/**
 * The placeholder title a quick-start task gets when the caller supplies none.
 * Exported as the single definition of "still untitled" — the session
 * auto-title hook compares against this exact string to decide whether a
 * task's title is safe to replace with an AI-generated one.
 */
export function defaultSessionTaskTitle(cwd: string): string {
  return `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`;
}

/**
 * Create (or reuse) the task and emit SESSION_START. Returns the task.
 * Throws QuickStartError with an HTTP-ish statusCode on invalid input so the
 * route wrapper can map it 1:1.
 */
export async function quickStartSession(params: QuickStartParams): Promise<Task> {
  const {
    message, messagePrefix, cwd, host, model, mode, existingTaskId, taskMeta,
    source, requestTs = Date.now(), engine, preassignedSessionId, walnutAgent,
  } = params;

  // "Ask Walnut": resolve the Personal AI's profile up front — the same bundle
  // (persona + standing memory + skills index + walnut MCP mount) and the same
  // chat-tuned effort a main-chat lane spawns with. Resolved BEFORE any task
  // write so a failure here fails the launch cleanly instead of leaving a task
  // whose session never got its persona.
  let walnutProfile: { profile: import('../types.js').SessionProfile; effort: import('../types.js').SessionEffort } | undefined;
  if (walnutAgent) {
    const { getConfig } = await import('../config-manager.js');
    const { buildLaneProfile } = await import('./personal-ai-lane.js');
    walnutProfile = await buildLaneProfile(await getConfig(), 'general');
  }
  const project = params.project?.trim() ?? '';
  // Captured at creation: "the caller did not file this task anywhere" is the
  // gate for the auto-organize pass at the end. Reading task.project later
  // would race the pass's own write on a retry.
  const callerSuppliedProject = project !== '';

  // Spill-to-disk: messages above the inline limit are saved to a temp file and
  // replaced with a short pointer prompt so Claude reads the full context via the Read tool.
  let sessionMessage = message;
  let largePromptFile: { localPath: string; originalLength: number } | undefined;
  const spill = spillLargePromptToFile(message);
  if (spill) {
    sessionMessage = spill.promptWithPointer;
    largePromptFile = { localPath: spill.filePath, originalLength: spill.originalLength };
    log.web.info(`${source}: spilled large prompt to file`, {
      filePath: spill.filePath,
      originalLength: spill.originalLength,
      host,
    });
  }
  if (messagePrefix) {
    sessionMessage = messagePrefix + sessionMessage;
  }

  let updatedTask: Task;

  if (existingTaskId) {
    // Retry mode: reuse existing task, archive error sessions.
    // Note: footer taskMeta picks (unread/priority/pinTier) are
    // intentionally IGNORED on retry — we preserve the original task's metadata.
    // getTask THROWS on an unknown id (it never returns null) and is a PREFIX
    // matcher with three failure modes: no match, ambiguous prefix, and a
    // store read failure. Only "no match" is the caller's 404; ambiguity is
    // their 400 (the task exists — they must be more specific), and anything
    // else is a real 500 that must not be dressed up as "task not found".
    try {
      updatedTask = await getTask(existingTaskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No task found matching')) {
        throw new QuickStartError(`Task "${existingTaskId}" not found`, 404);
      }
      if (msg.includes('Ambiguous ID prefix')) {
        throw new QuickStartError(msg, 400);
      }
      throw err;
    }
    // Archive all error/stopped sessions under this task to free the slot
    const existingSessions = await getSessionsForTask(updatedTask.id);
    for (const s of existingSessions) {
      if (!s.archived && (s.process_status === 'error' || s.process_status === 'stopped')) {
        await updateSessionRecord(s.claudeSessionId, { archived: true, archive_reason: 'retry' });
        try {
          const { clearSession, clearSessionSlot } = await import('../task-manager.js');
          await clearSession(updatedTask.id, s.claudeSessionId);
          await clearSessionSlot(updatedTask.id, s.claudeSessionId);
        } catch { /* task may not exist */ }
      }
    }
  } else {
    // Normal mode: create new task. Ask Walnut gets its own placeholder — the
    // generic one is "Session: <basename(cwd)>", which for WALNUT_HOME reads
    // "Session: .open-walnut" (the data dir's name means nothing to the user).
    const placeholderTitle = walnutAgent ? 'Ask Walnut' : defaultSessionTaskTitle(cwd);
    const title = params.taskTitle?.trim() || placeholderTitle;
    // Folder → default project: when THIS launch creates the registry row (the
    // draft's folder-derived default, typically the folder's basename), the
    // launch folder becomes the new project's default_cwd/default_host, so the
    // next pick of that folder resolves straight to it (projectByCwd). Gated on
    // projectFromFolder — only a folder-derived pick may bind a folder — and on
    // `created`: an EXISTING row's mapping is the user's, never rewritten. The
    // row does get created moments before addTask would have anyway; a rare
    // addTask failure leaves an empty (idempotently reusable) project behind,
    // which is harmless next to failing the launch on a registry race.
    let projectIsNew = false;
    if (project && params.projectFromFolder) {
      try {
        projectIsNew = (await ensureProject(project)).created;
      } catch (err) {
        // Same 400 mapping as addTask below — ensureProject runs the name gate.
        if (err instanceof InvalidProjectNameError) throw new QuickStartError(err.message, 400);
        throw err;
      }
    }
    // Pin decision, made BEFORE the create so the task is born pinned in one
    // write: `null` = the caller explicitly opted out (the launcher's unpin
    // gesture, a routine run); anything else joins the board.
    const pinNewTask = taskMeta?.pinTier !== null;
    // Tier resolved to a value addTask will accept, BEFORE the create, so the
    // pin AND its tier land in ONE store write (the old create → setFocusTier
    // pair could half-land and silently drop the task into Satellite).
    //
    // Deliberately LENIENT here, unlike the task-create REST edges: the
    // launcher persists the last tier in localStorage, so after the user
    // deletes that tier in Settings a stale ct_* arrives on every launch. That
    // is a stale remembered pick, not a caller error — downgrade it to
    // Satellite (what setFocusTier used to self-heal it to) rather than failing
    // the launch. See the matching note in web/routes/sessions.ts.
    let bornTier: string | undefined;
    if (pinNewTask && taskMeta?.pinTier && taskMeta.pinTier !== 'satellite') {
      const known = ['focus', 'backlog', 'wait'].includes(taskMeta.pinTier)
        || (await getCustomTiers()).some((t) => t.id === taskMeta.pinTier);
      if (known) bornTier = taskMeta.pinTier;
      else {
        log.web.warn(`${source}: unknown pinTier on launch, filing in Satellite`, {
          tier: taskMeta.pinTier,
        });
      }
    }
    let task: Task;
    try {
      // ONE store write: cwd/priority/dates ride the create instead of a
      // follow-up updateTask. Every task op is a whole-store read-modify-write
      // behind one lock, so each op this path sheds is real launch latency —
      // under machine load the old create → update → tier → re-read chain
      // convoyed to 20-30s of "Starting…" (2026-08-26).
      ({ task } = await addTask({
        title,
        project,
        source: 'local',
        cwd,
        // 'none' is a sentinel meaning "don't write priority" — lets a caller
        // omit the field without clearing an existing value.
        ...(taskMeta?.priority && taskMeta.priority !== 'none' ? { priority: taskMeta.priority } : {}),
        // Dates ride the create too (route already validated they parse).
        ...(taskMeta?.due_date ? { due_date: taskMeta.due_date } : {}),
        ...(taskMeta?.start_date ? { start_date: taskMeta.start_date } : {}),
        ...(taskMeta?.end_date ? { end_date: taskMeta.end_date } : {}),
        ...(pinNewTask ? { pinned: true } : {}),
        ...(bornTier ? { focus_tier: bornTier } : {}),
        // The per-task Personal-AI marker — task lists key the amber title on
        // THIS, never on the project name (an ordinary task filed under the
        // same project must not light up).
        ...(walnutAgent ? { walnut_agent: true } : {}),
      }));
    } catch (err) {
      // Client-supplied project seed the registry rejects — a caller error, not
      // a server fault. Name gate (path separators etc.) → 400; provider-claimed
      // project → 409, same mapping as every other addTask route.
      if (err instanceof InvalidProjectNameError) throw new QuickStartError(err.message, 400);
      if (err instanceof ProjectSourceConflictError) throw new QuickStartError(err.message, 409);
      throw err;
    }
    if (projectIsNew) {
      try {
        await setProjectMetadata(project, {
          default_cwd: cwd.replace(/\/+$/, '') || cwd,
          ...(host ? { default_host: host } : {}),
        });
      } catch (err) {
        // Best-effort: the stamp only powers future folder→project resolution —
        // never fail a launch over it.
        log.web.warn(`${source}: failed to stamp new project default_cwd`, {
          project, cwd, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // One rare follow-up write left: `unread` doesn't ride AddTaskInput. The
    // tier no longer needs one — it rode the create above.
    const wantsUnread = taskMeta?.unread === true;
    if (wantsUnread) {
      await updateTask(task.id, { unread: true }, { source });
    }
    // Common path (no unread): the addTask return IS the final task — skip the
    // whole-store re-read that used to run on every launch.
    updatedTask = wantsUnread ? await getTask(task.id) : task;
  }

  if (!existingTaskId) {
    bus.emit(EventNames.TASK_CREATED, { task: updatedTask }, ['web-ui', 'main-agent'], { source });
  }

  // A start targeting a remote host is deliberate (human click or a routine the
  // user configured) — forget any cached connection failure so we reconnect
  // fresh rather than fast-fail.
  if (host) {
    const { clearDaemonFailureCache } = await import('../../providers/daemon-connection.js');
    clearDaemonFailureCache(host);
  }

  // Seed the session record BEFORE the spawn when the id is caller-minted.
  //
  // Why this is required, not just nice: returning the id lets the UI mount the
  // real session panel immediately, and that panel's first act is
  // GET /api/sessions/:id. Until the spawn is confirmed (~200ms local, seconds
  // for a cold remote daemon) no record exists, so that GET 404s — and a 404 is
  // treated as "session does not exist" (not a transient error), so the panel
  // would settle permanently into its "Untitled session" empty state. Writing a
  // minimal row up front makes the read succeed from the first frame; the spawn's
  // own persistSessionRecord then fills in pid/outputFile/model (it takes the
  // "row exists" branch and updates in place — same id, so no duplicate).
  //
  // Safe against the orphan sweepers: a pid-less non-terminal row is only reaped
  // after a 2-minute grace period on last_status_change (session-health-monitor's
  // ORPHAN_GRACE_MS), which is far longer than any spawn.
  if (preassignedSessionId && !isAcpEngine(engine)) {
    try {
      const { createSessionRecord } = await import('../session-tracker.js');
      await createSessionRecord(preassignedSessionId, updatedTask.id, project, cwd, {
        title: updatedTask.title,
        mode: mode as import('../types.js').SessionMode | undefined,
        host,
        // Ask Walnut: the persona lives on the RECORD so a cold --resume
        // rebuilds it (same contract as a chat lane's record).
        ...(walnutProfile ? { profile: walnutProfile.profile, effort: walnutProfile.effort } : {}),
        // No turn has begun (the CLI isn't up yet) — 'running' would show a
        // phantom "working…" badge on a session that hasn't started.
        initialProcessStatus: 'idle',
        // Marks "no pid YET" so the liveness overlay doesn't read the missing pid
        // as a dead process and persist 'stopped' on a session just launched.
        initialStatusReason: 'awaiting_spawn',
      });
    } catch (err) {
      // Non-fatal: the spawn path persists the record too. Worst case the UI's
      // first metadata read 404s and the panel shows its empty state briefly.
      log.web.warn(`${source}: pre-spawn session record seed failed`, {
        sessionId: preassignedSessionId, taskId: updatedTask.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Emit SESSION_START event (sessionMessage includes image path annotations if the caller prepended them)
  bus.emit(EventNames.SESSION_START, {
    taskId: updatedTask.id,
    message: sessionMessage,
    cwd,
    project,
    mode,
    model,
    host,
    largePromptFile,
    requestTs,
    engine,
    // Ask Walnut: the spawn takes the Personal AI profile + chat-tuned effort.
    ...(walnutProfile ? { profile: walnutProfile.profile, effort: walnutProfile.effort } : {}),
    // ACP (codex) mints its own ids inside the adapter — only forward for native.
    ...(preassignedSessionId && !isAcpEngine(engine) ? { preassignedSessionId } : {}),
  }, ['session-runner'], { source });

  // TEXT-FIRST auto-title: the launch message rides SESSION_START, which the
  // hook dispatcher never maps to onMessageSend — without this kick the task
  // would keep its `Session: <basename>` placeholder until the user's SECOND
  // message. Fire-and-forget (the helper polls for the CLI spawn internally);
  // native engine only — ACP mints its own ids and has no control pipe. The
  // placeholder check here skips callers with a real title (fix-walnut,
  // routines, retries of an already-titled task) without the helper's poll.
  if (preassignedSessionId && !isAcpEngine(engine) && message.trim()
      && updatedTask.title === (walnutAgent ? 'Ask Walnut' : defaultSessionTaskTitle(cwd))) {
    import('../session-hooks/builtins.js')
      .then(({ autoTitleFromLaunch }) => autoTitleFromLaunch(preassignedSessionId, updatedTask.id, message, cwd))
      .catch((err) => log.web.warn(`${source}: launch auto-title failed`, {
        taskId: updatedTask.id, error: err instanceof Error ? err.message : String(err),
      }));
  }

  // AUTO-ORGANIZE: fast-model project placement, replacing the old client-side
  // "[Quick Start] …move the task" wake-up of the Personal AI agent. Only for
  // tasks the caller left unfiled — a caller that supplied a project
  // (fix-walnut, routines) placed the task deliberately; retries were already
  // organized (or deliberately left) on the original launch. Gated off in
  // test servers (real ~/.aws → live Bedrock calls + mid-assertion task moves).
  const { backgroundAiDisabled } = await import('../cheap-model.js');
  if (!existingTaskId && !backgroundAiDisabled() && !callerSuppliedProject) {
    import('../session-organize.js')
      .then(({ organizeQuickStartTask }) => organizeQuickStartTask(updatedTask.id, cwd, message))
      .catch((err) => log.web.warn(`${source}: auto-organize failed`, {
        taskId: updatedTask.id, error: err instanceof Error ? err.message : String(err),
      }));
  }

  log.web.info(`${source}: created task + started session`, {
    taskId: updatedTask.id, cwd, host, project: project || 'Inbox', retry: !!existingTaskId,
  });

  return updatedTask;
}
