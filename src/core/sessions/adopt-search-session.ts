/**
 * "Open as session" for the ✦ AI search card — ADOPT the session the search
 * already ran in, instead of starting a second agent on the same question.
 *
 * Why this exists: the AI search lane is not an API call, it is a `claude -p`
 * child (core/task-search-agent.ts → providers/micro-claude*). That child is a
 * real Claude Code session — its transcript sits in
 * ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl and `--resume <sessionId>`
 * from the same cwd continues it under the same id (verified 2026-09-16). So
 * "open this search as a session" is a BOOKKEEPING act: mint the task, register
 * the existing session in its slot, and the user's first follow-up rides the
 * ordinary cold `--resume` path into the conversation that already has the
 * answer. Starting a fresh session instead made the UI look like it re-ran the
 * search from zero, which is exactly what the user reported.
 *
 * Invariants this file encodes, each one a way the feature could quietly become
 * "a second agent redoing the work" again:
 *   - IDEMPOTENT, AND NOT ONLY WITHIN THE RUN CACHE: an already-tracked session
 *     is returned; a task the user deleted from under a still-tracked session is
 *     re-linked, not treated as a lost race; and a query already adopted once is
 *     found by its ask even after the search run has aged out of memory.
 *   - The caller names a QUERY, never a session id (resolveAgentSearchRun), so
 *     no client can ask Walnut to adopt an arbitrary session on the host.
 *   - The adopted record carries the Personal AI profile, because a resume
 *     spawns from the RECORD: without it the follow-up would wake up as a bare
 *     coding agent, unable to search anything.
 *   - The transcript is MOVED out of the micro-Claude scratch bucket into
 *     WALNUT_HOME's project dir. Left where it was born it sits under a temp cwd
 *     that Claude Code's own retention (cleanupPeriodDays, 30 by default) sweeps,
 *     and the ask would silently become "No conversation found" weeks later.
 */

import { existsSync } from 'node:fs';
import { log } from '../../logging/index.js';
import { WALNUT_HOME } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { canonicalJsonlPath } from '../session-file-reader.js';
import { resolveAgentSearchRun } from '../task-search-agent.js';
import { ASK_WALNUT_PROJECT, GENERAL_AGENT_ID } from './ask-agent.js';
import type { SessionProfile, SessionEffort } from '../types.js';

export class AdoptSearchSessionError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'AdoptSearchSessionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AdoptedSearchSession {
  sessionId: string;
  taskId: string;
  /** The session was already tracked — this is that conversation, not a copy. */
  reused: boolean;
}

/** Board titles are one line; the search box allows 400 chars. */
const TITLE_MAX = 80;
/** Marks the asks this path creates, so a later press can find the SAME ask for
 *  a query whose search run has since aged out of the in-memory map. */
export const SEARCH_ASK_TAG = 'walnut:ai-search-ask';

function taskTitle(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat;
}

export interface AdoptAgentSearchSessionOptions {
  /** How long to wait on a search still in flight (see resolveAgentSearchRun). */
  waitMs?: number;
  /**
   * May this call START a search when none has run for the query? The card's
   * lane debounces ~1s, so a fast click arrives before any search exists and
   * this is what keeps the click from degrading into a fresh agent. FALSE when
   * the user has the AI lane switched off (or it just failed): running a search
   * they turned off would spend their tokens against their own setting.
   */
  startIfMissing?: boolean;
  /** The card's progress id, so a search started here still streams its live
   *  lines into the panel the user is watching. */
  progressId?: string;
}

/** The ask a previous press already created for this query, if its session is
 *  still usable. Keyed by tag + title, which IS the query (taskTitle is pure). */
async function findExistingSearchAsk(query: string): Promise<AdoptedSearchSession | undefined> {
  const title = taskTitle(query);
  try {
    const { queryTasks } = await import('../task-manager.js');
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const candidates = (await queryTasks({ tagsAll: [SEARCH_ASK_TAG], projects: [ASK_WALNUT_PROJECT] }))
      .filter((t) => t.title === title && !!t.session_id)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    for (const task of candidates) {
      const sessionId = task.session_id!;
      const record = await getSessionByClaudeId(sessionId).catch(() => null);
      // An archived record is a retired conversation (a failed resume archives
      // one) — reopening it would hand the user a dead session.
      if (!record || record.archived) continue;
      if (!existsSync(canonicalJsonlPath(sessionId, record.cwd ?? WALNUT_HOME))) continue;
      return { sessionId, taskId: task.id, reused: true };
    }
  } catch (err) {
    // Best-effort dedup: never fail an adopt because the lookup did.
    log.session.debug('search-ask lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

/**
 * Hand the user the session that ran the AI search for `query`.
 *
 * Throws AdoptSearchSessionError with `code`:
 *   bad_query     — too short / too long to have been searched (400)
 *   no_session    — nothing ran this query, or its run failed (404)
 *   no_transcript — the run left no transcript to continue (404)
 * All of them mean "there is nothing to reopen"; the caller then starts a
 * session the normal way.
 */
export async function adoptAgentSearchSession(
  query: string,
  opts: AdoptAgentSearchSessionOptions = {},
): Promise<AdoptedSearchSession> {
  const trimmed = query.trim();
  if (trimmed.length < 4) {
    throw new AdoptSearchSessionError('query is too short to have an AI search session', 400, 'bad_query');
  }
  if (trimmed.length > 400) {
    throw new AdoptSearchSessionError('query is too long to have an AI search session', 400, 'bad_query');
  }

  // Before spending anything: this query may already HAVE an ask (yesterday's
  // press, whose run has since left the 2h map). Reopening that conversation is
  // strictly better than searching again — it holds the follow-ups too.
  const run = await resolveAgentSearchRun(trimmed, { ...opts, startIfMissing: false });
  if (!run) {
    const previous = await findExistingSearchAsk(trimmed);
    if (previous) return previous;
  }
  const resolved = run ?? (opts.startIfMissing
    ? await resolveAgentSearchRun(trimmed, opts)
    : undefined);
  if (!resolved) {
    throw new AdoptSearchSessionError('no AI search session to continue for this query', 404, 'no_session');
  }

  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const already = await getSessionByClaudeId(resolved.sessionId);
  if (already && !already.archived && already.taskId) {
    return { sessionId: resolved.sessionId, taskId: already.taskId, reused: true };
  }
  if (already?.archived) {
    // Retired (a resume that could not find the conversation archives it). Do
    // not hand back a dead session — let the caller start a real one.
    throw new AdoptSearchSessionError('the AI search session has been archived', 404, 'no_session');
  }

  // WHERE IS THE TRANSCRIPT NOW? The CLI finds a conversation by (cwd, id), and
  // the run only remembers the cwd it was BORN in — a previous adoption of the
  // same session already moved the file to WALNUT_HOME, so trusting the run's cwd
  // reports "nothing to reopen" for a conversation that is right there (found by
  // the re-link test). No transcript anywhere is the real dead end: an empty
  // panel now and a first follow-up that dies on "No conversation found".
  const transcriptCwd = [already?.cwd, resolved.cwd, WALNUT_HOME]
    .filter((c): c is string => !!c)
    .find((c) => existsSync(canonicalJsonlPath(resolved.sessionId, c)));
  if (!transcriptCwd) {
    throw new AdoptSearchSessionError('the AI search session left no transcript', 404, 'no_transcript');
  }

  // Resolved BEFORE any write (quick-start's own ordering): a profile failure
  // must not leave a task whose session can never speak as Walnut.
  const { getConfig } = await import('../config-manager.js');
  const { buildLaneProfile } = await import('./personal-ai-lane.js');
  const { getAskWalnutLaunchPrefs, resolveAskWalnutEffort } = await import('./ask-walnut-launch.js');
  // The Personal AI itself: a search the user wants to keep asking about is an
  // "Ask Walnut", never a Mentor/Note-Assistant ask (those have their own entry
  // points, and the card belongs to the task board).
  const laneProfile = await buildLaneProfile(await getConfig(), GENERAL_AGENT_ID);
  const remembered = await getAskWalnutLaunchPrefs();
  // No model is pinned on an adopted session (the resume takes the configured
  // default), so the remembered effort applies unconditionally — same call the
  // Ask Walnut launch makes with an unnamed model.
  const effort = resolveAskWalnutEffort(remembered.effort, undefined, laneProfile.effort);

  // Move the transcript into WALNUT_HOME's project dir, so the adopted ask is
  // shaped like every other ask AND survives Claude Code's retention sweep of
  // temp cwds. If the move does not happen, keep the cwd where the transcript
  // actually is — a record pointing at a file the CLI cannot find is worse than
  // an unusual cwd.
  const { migrateSessionJsonlForCwd } = await import('../session-jsonl-migration.js');
  const moved = transcriptCwd === WALNUT_HOME
    ? { migrated: true, reason: 'already-home' }
    : await migrateSessionJsonlForCwd(resolved.sessionId, transcriptCwd, WALNUT_HOME)
      .catch(() => ({ migrated: false, reason: 'threw' }));
  const cwd = moved.migrated ? WALNUT_HOME : transcriptCwd;
  if (!moved.migrated) {
    log.session.info('adopted search session keeps its scratch cwd', {
      sessionId: resolved.sessionId, cwd, reason: moved.reason,
    });
  }

  const title = taskTitle(trimmed);
  const created = await createAskTask(title, trimmed);
  const at = new Date(resolved.at).toISOString();
  const record = await claimSession({
    sessionId: resolved.sessionId,
    taskId: created.taskId,
    title,
    cwd,
    at,
    profile: laneProfile.profile,
    effort,
  });
  if (!record) {
    // Someone adopted this session between the check above and the write. Drop
    // the task this call minted (a lost race must not leave an empty orphan) and
    // return the conversation, which is what the caller actually wanted.
    const { deleteTask } = await import('../task-manager.js');
    try { await deleteTask(created.taskId); } catch { /* best-effort */ }
    const winner = await getSessionByClaudeId(resolved.sessionId).catch(() => null);
    if (winner?.taskId) return { sessionId: resolved.sessionId, taskId: winner.taskId, reused: true };
    throw new AdoptSearchSessionError('the AI search session could not be adopted', 409, 'race_lost');
  }

  const { linkSession } = await import('../task-manager.js');
  const { task: linked } = await linkSession(created.taskId, resolved.sessionId);
  const { emitSessionStatusChanged } = await import('../session-tracker.js');
  // Two emits, because nothing else on this path emits anything a browser sees:
  // addTask is storage only, importSessionRecord and linkSession are silent, and
  // the external importer's coarse nudge routes to NO destinations. TASK_CREATED
  // with the POST-LINK task carries session_id, so one event seats the board row;
  // the status emit seats its "stopped" badge and is what re-exports the session
  // projection the phone reads (no session STARTED here — the CLI already exited).
  bus.emit(EventNames.TASK_CREATED, { task: linked }, ['web-ui', 'main-agent'], { source: 'agent-search-adopt' });
  emitSessionStatusChanged(record, {}, ['*'], { source: 'agent-search-adopt' });
  log.session.info('adopted AI search session', {
    sessionId: resolved.sessionId,
    taskId: created.taskId,
    cwd,
    model: resolved.model,
    movedTranscript: moved.migrated,
  });
  return { sessionId: resolved.sessionId, taskId: created.taskId, reused: false };
}

async function createAskTask(title: string, query: string): Promise<{ taskId: string }> {
  const { addTask, InvalidProjectNameError, ProjectSourceConflictError } = await import('../task-manager.js');
  try {
    const { task } = await addTask({
      title,
      project: ASK_WALNUT_PROJECT,
      source: 'local',
      // WALNUT_HOME, like every other ask (the route pins the same for a normal
      // Ask Walnut launch).
      cwd: WALNUT_HOME,
      pinned: true,
      focus_tier: 'focus',
      // The per-task Personal-AI marker every ask carries (drawer list, amber
      // title, profile drift repair all key on it).
      walnut_agent: true,
      tags: [SEARCH_ASK_TAG],
      description:
        `Started as an AI search on the task board: "${query}".\n\n`
        + 'This session IS that search — the question, what it looked at and its answer are already in the transcript above. Keep asking here.',
    });
    return { taskId: task.id };
  } catch (err) {
    // Same mapping every other addTask edge uses, so a claimed/invalid project
    // is a client-visible 400/409 instead of a 500 the caller cannot read.
    if (err instanceof InvalidProjectNameError) {
      throw new AdoptSearchSessionError(err.message, 400, 'bad_project');
    }
    if (err instanceof ProjectSourceConflictError) {
      throw new AdoptSearchSessionError(err.message, 409, 'project_conflict');
    }
    throw err;
  }
}

/**
 * Put the existing claude session in this task's slot: import it, or RE-LINK a
 * record that is already tracked but whose task is gone (the user deleted the
 * ask; `deleteTask` clears `task_id` and leaves the session row). Treating that
 * as a lost race is how the second press became a 500 with no way back to the
 * conversation. Returns undefined only when another writer genuinely owns it.
 */
async function claimSession(args: {
  sessionId: string;
  taskId: string;
  title: string;
  cwd: string;
  at: string;
  profile: SessionProfile;
  effort: SessionEffort;
}): Promise<Awaited<ReturnType<typeof import('../session-tracker.js')['importSessionRecord']>> | undefined> {
  const { importSessionRecord, getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  try {
    return await importSessionRecord({
      claudeSessionId: args.sessionId,
      taskId: args.taskId,
      project: ASK_WALNUT_PROJECT,
      cwd: args.cwd,
      title: args.title,
      engine: 'claude',
      provider: 'cli',
      // The run's own clock, not "now": the record must sort by when the search
      // actually happened (importSessionRecord's standing rule for imports).
      startedAt: args.at,
      lastActiveAt: args.at,
      // The search is one question and one answer; a follow-up grows it.
      messageCount: 2,
      profile: args.profile,
      effort: args.effort,
      // Without a reason, a stopped record classifies as "unknown" and the health
      // monitor keeps spending its rescue-probe budget on a session no daemon has
      // ever heard of. This search ENDED; say so.
      status_reason: 'normal_completion',
      human_note: `Adopted from the ✦ AI search for "${args.title}".`,
    });
  } catch {
    const existing = await getSessionByClaudeId(args.sessionId).catch(() => null);
    if (!existing || existing.taskId) return undefined; // genuinely someone else's
    // Tracked but orphaned: adopt it into this task.
    return await updateSessionRecord(args.sessionId, {
      taskId: args.taskId,
      project: ASK_WALNUT_PROJECT,
      cwd: args.cwd,
      title: args.title,
      profile: args.profile,
      effort: args.effort,
    }).catch(() => undefined) ?? undefined;
  }
}
