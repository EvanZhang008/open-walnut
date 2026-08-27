/**
 * Session extras core — provider controls (GET/apply), settings snapshot,
 * side questions (list/ask/promote/delete), workflow reconstruction, plan
 * read, subagent-lane history, execute-compact, queued-message management,
 * and host directory listing for the path picker.
 *
 * Shared by the web routes (src/web/routes/sessions.ts), the /api/v1 mobile
 * routes (session-extras-v1.ts), and the daemon control relay (cloud
 * companion path) so there is exactly ONE implementation of each behavior —
 * the same contract session-lifecycle.ts established for Wave 1.
 *
 * Error contract: validation/lookup failures throw SessionControlError with
 * an HTTP-ish statusCode. Callers map it onto their own error shape.
 *
 * Provider/tracker imports are dynamic where a static import would risk a
 * load cycle (same convention as session-lifecycle.ts).
 */

import { SessionControlError } from './session-controls.js';
import { CLAUDE_SESSION_MODES, changeSessionMode, persistSessionModeChange } from './session-lifecycle.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { SessionEffort, SessionMode } from '../types.js';
import { VALID_SESSION_EFFORT_IDS, SESSION_MODE_LABELS } from '../types.js';
import { listLocalDirs, listRemoteDirs } from './dir-listing.js';

// ── Provider controls ────────────────────────────────────────────────────────

export interface SessionControlsPayload {
  engine: 'codex' | 'claude';
  controls: unknown[];
}

function claudeModeControls(currentValue: string): unknown[] {
  return [{
    id: 'mode',
    name: 'Mode',
    type: 'select',
    currentValue,
    // Labels come from the registry, not from capitalizing the id — 'dontAsk'
    // would otherwise render as "DontAsk" on the phone and in the pill.
    options: CLAUDE_SESSION_MODES.map((value) => ({
      value,
      name: SESSION_MODE_LABELS[value] ?? value,
    })),
  }];
}

/** Provider-neutral selectable session controls (mode for Claude, native set for Codex). */
export async function getSessionControls(sessionId: string): Promise<SessionControlsPayload> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);
  if (record.engine === 'codex') {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined);
    if (!session) throw new SessionControlError('Codex ACP session is not available', 409);
    return {
      engine: 'codex',
      controls: session.sessionControls.filter((control) => control.id !== 'model'),
    };
  }
  return { engine: 'claude', controls: claudeModeControls(record.mode || 'default') };
}

/** Apply one provider-advertised control (mode for Claude; any Codex control). */
export async function applySessionControl(
  sessionId: string,
  id: unknown,
  value: unknown,
): Promise<SessionControlsPayload> {
  if (typeof id !== 'string' || typeof value !== 'string' || !id || !value) {
    throw new SessionControlError('id and value must be non-empty strings', 400);
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);

  if (record.engine === 'codex') {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined);
    if (!session) throw new SessionControlError('Codex ACP session is not available', 409);
    const control = session.sessionControls.find((candidate) => candidate.id === id);
    if (!control || !control.options.some((option) => option.value === value)) {
      throw new SessionControlError('unknown control or value', 400);
    }
    if (!await session.setConfigOption(id, value)) {
      throw new SessionControlError('Codex ACP control change failed', 409);
    }
    if (id === 'collaboration_mode') {
      // Mirror Codex's plan/exec split onto the record's mode field so the
      // rest of the app (badges, resume args) stays coherent.
      const mirroredMode: SessionMode = value === 'plan'
        ? 'plan'
        : record.mode === 'plan' ? 'default' : record.mode;
      await persistSessionModeChange(record, sessionId, mirroredMode);
    }
    return {
      engine: 'codex',
      controls: session.sessionControls.filter((candidate) => candidate.id !== 'model'),
    };
  }

  if (id !== 'mode' || !CLAUDE_SESSION_MODES.includes(value as SessionMode)) {
    throw new SessionControlError('Claude sessions only support the mode control', 400);
  }
  let updated;
  try {
    updated = await changeSessionMode(record, sessionId, value as SessionMode);
  } catch (err) {
    if (err instanceof SessionControlError) throw err;
    // A live CLI that rejects the switch (or a dead transport) is a conflict,
    // matching the web route's historical 409-on-error behavior.
    throw new SessionControlError(err instanceof Error ? err.message : String(err), 409);
  }
  return { engine: 'claude', controls: claudeModeControls(updated.mode) };
}

// ── Settings snapshot ────────────────────────────────────────────────────────

export interface SessionSettingsPayload {
  live: boolean;
  requested: { model?: string; effort?: SessionEffort; mode?: SessionMode };
  applied: { model: string | null; effort: string | null; mode: string | null } | null;
  effective: { effortLevel: SessionEffort | null } | null;
  details?: {
    contextUsage: unknown | null;
    usage: Record<string, unknown> | null;
    binaryVersion: { version?: string; buildTime?: string } | null;
    /** The two windows Walnut resolved, so the panel can show the SAME
     *  denominator the badge uses. The CLI's own contextUsage.maxTokens is the
     *  auto-compact window, which is why the panel and the badge used to
     *  disagree (25% vs 10% on 2026-08-23). */
    windows: { modelMax: number | null; autoCompactAt: number | null } | null;
  };
}

/** Requested vs applied settings for the picker (+ optional usage details). */
export async function getSessionSettings(sessionId: string, wantDetails: boolean): Promise<SessionSettingsPayload> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);
  const requested = {
    model: record.cliModel ?? record.model,
    effort: record.effort,
    mode: record.mode,
  };
  let applied: SessionSettingsPayload['applied'] = null;
  let effective: SessionSettingsPayload['effective'] = null;
  let details: SessionSettingsPayload['details'];
  // Attach-on-demand (same as /effort and /model) so a live-but-unmapped
  // session still answers. getSettingsSnapshot() resolves null on timeout/old
  // CLI — never throws.
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined);
  if (session) {
    const [settingsSnapshot, contextUsage, usage, binaryVersion] = await Promise.all([
      session.getSettingsSnapshot().catch(() => null),
      wantDetails ? session.getContextUsage().catch(() => null) : Promise.resolve(null),
      wantDetails ? session.getUsage().catch(() => null) : Promise.resolve(null),
      wantDetails ? session.getBinaryVersion().catch(() => null) : Promise.resolve(null),
    ]);
    if (settingsSnapshot) {
      const settings = settingsSnapshot.applied;
      // Mode has no field in get_settings' applied block — the live session's
      // _mode IS the runtime truth (reconciled from the CLI's system/status
      // events, incl. our set_permission_mode echoes and in-CLI EnterPlanMode).
      applied = { model: settings.model ?? null, effort: settings.effort ?? null, mode: session.mode ?? null };
      const configuredEffort = settingsSnapshot.effective?.effortLevel;
      effective = {
        effortLevel: typeof configuredEffort === 'string' && VALID_SESSION_EFFORT_IDS.has(configuredEffort)
          ? configuredEffort as SessionEffort
          : null,
      };
      // Opportunistically reconcile record/badge state from this same read —
      // one round-trip serves both the picker and the persisted truth.
      void session.refreshAppliedSettings('picker-pull', settingsSnapshot.applied).catch(() => null);
    }
    if (wantDetails) {
      details = { contextUsage, usage, binaryVersion, windows: session.contextWindowsForUi() };
    }
  } else if (wantDetails) {
    details = { contextUsage: null, usage: null, binaryVersion: null, windows: null };
  }
  return { live: applied !== null, requested, applied, effective, ...(details !== undefined ? { details } : {}) };
}

// ── Side questions ───────────────────────────────────────────────────────────

/** History list for the side-question drawer. */
export async function listSessionSideQuestions(sessionId: string): Promise<{ sideQuestions: unknown[] }> {
  const { listSideQuestions } = await import('../side-questions.js');
  return { sideQuestions: await listSideQuestions(sessionId) };
}

/** Ask a side question on the live CLI, persist the Q&A, broadcast the result. */
export async function askSessionSideQuestion(sessionId: string, question: unknown): Promise<{ sideQuestion: unknown }> {
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new SessionControlError('question (non-empty string) is required', 400);
  }
  // Attach-on-demand: findByClaudeId only sees the in-memory map, so a
  // genuinely-alive session would falsely 404 here. getOrAttachLiveSession
  // rehydrates via attachToExisting — same resolution a send turn gets.
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  let session;
  try {
    session = await sessionRunner.getOrAttachLiveSession(sessionId);
  } catch (err) {
    session = undefined;
    log.session.warn('side question: attach failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!session) throw new SessionControlError('Live session not found', 404);
  try {
    const answer = await session.askSideQuestion(question.trim());
    const { addSideQuestion } = await import('../side-questions.js');
    const entry = await addSideQuestion(sessionId, question.trim(), answer);
    bus.emit(EventNames.SESSION_SIDE_QUESTION_DONE, {
      sessionId, id: entry.id, question: entry.question, answer: entry.answer, createdAt: entry.createdAt,
    }, ['*'], { source: 'session-runner' });
    return { sideQuestion: entry };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.session.warn('side question failed', { sessionId, error: msg });
    bus.emit(EventNames.SESSION_SIDE_QUESTION_ERROR, {
      sessionId, question: question.trim(), error: msg,
    }, ['*'], { source: 'session-runner' });
    throw new SessionControlError(msg, 502);
  }
}

/** Turn a side-question Q&A into a task (subtask of the session's task when linked). */
export async function promoteSessionSideQuestion(
  sessionId: string,
  id: string,
): Promise<{ taskId: string; parentTaskId?: string }> {
  const { getSideQuestion, markPromoted } = await import('../side-questions.js');
  const entry = await getSideQuestion(sessionId, id);
  if (!entry) throw new SessionControlError('Side question not found', 404);
  // If this session is working on a task, file the promoted Q&A as a SUBTASK
  // of it (addTask inherits the parent's project/source). Ad-hoc sessions
  // fall back to a top-level task in Inbox.
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const sessionRecord = await getSessionByClaudeId(sessionId);
  const parentTaskId = sessionRecord?.taskId?.trim() || undefined;
  const { addTask, linkSession } = await import('../task-manager.js');
  const { task } = await addTask({
    title: entry.question,
    description: entry.answer,
    ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
    // A person clicked "promote this Q&A" — same board default as any other
    // hand-made task (Satellite = pinned, no stored tier).
    pinned: true,
  });
  // Link the task back to the session so it shows under that session's history.
  await linkSession(task.id, sessionId);
  await markPromoted(sessionId, id, task.id);
  return { taskId: task.id, ...(task.parent_task_id ? { parentTaskId: task.parent_task_id } : {}) };
}

/** Remove a Q&A from the side-question history. */
export async function removeSessionSideQuestion(sessionId: string, id: string): Promise<{ status: 'deleted' }> {
  const { deleteSideQuestion } = await import('../side-questions.js');
  const ok = await deleteSideQuestion(sessionId, id);
  if (!ok) throw new SessionControlError('Side question not found', 404);
  return { status: 'deleted' };
}

// ── Workflow reconstruction ──────────────────────────────────────────────────

/**
 * Route-level deadline: every session panel mount fetches this, and for a
 * remote session the manifest read rides the daemon connection — a wedged
 * daemon held this request for minutes (measured 382s worst case). Timing out
 * answers null ("no workflow to restore"); a live run is driven by the event
 * stream, not this read.
 */
const WORKFLOW_RECONSTRUCT_TIMEOUT_MS = 5_000;

/** Reconstruct the dynamic-workflow progress panel from the on-disk manifest (null = none). */
export async function getSessionWorkflowPayload(sessionId: string): Promise<Record<string, unknown> | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  const { reconstructWorkflowProgress } = await import('../session-history.js');
  const payload = await Promise.race([
    reconstructWorkflowProgress(sessionId, record?.cwd, record?.host),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => {
        log.web.warn('workflow reconstruct timed out — answering empty', { sessionId, host: record?.host });
        resolve(null);
      }, WORKFLOW_RECONSTRUCT_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
  return (payload as Record<string, unknown> | null) ?? null;
}

// ── Plan read ────────────────────────────────────────────────────────────────

export interface SessionPlanPayload {
  content: string;
  planFile?: string;
  sourceSessionId?: string;
}

/** Read plan content for a plan session (or its source plan session, one hop). */
export async function getSessionPlanPayload(sessionId: string): Promise<SessionPlanPayload> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  // Exec sessions can re-enter plan mode via execute-continue, creating their
  // own plan; when that happened the session's own plan wins over the (now
  // stale) source plan. planCompleted alone is sufficient — plan content can
  // still be recovered from JSONL even without a planFile on disk.
  const hasOwnPlan = !!record.planCompleted;
  const planSessionId = hasOwnPlan ? sessionId : (record.fromPlanSessionId ?? sessionId);
  const isFollowedLink = planSessionId !== sessionId;

  // Strategy 1: readPlanFromSession (planFile on disk, or JSONL slug → file).
  const { readPlanFromSession } = await import('../../utils/plan-message.js');
  const planResult = await readPlanFromSession(planSessionId);
  if (!('error' in planResult)) {
    return {
      content: planResult.content,
      planFile: planResult.planFile,
      ...(isFollowedLink ? { sourceSessionId: planSessionId } : {}),
    };
  }

  // Strategy 2: extractPlanContent from JSONL (Write to plans/ or ExitPlanMode.input.plan).
  const planRecord = isFollowedLink ? await getSessionByClaudeId(planSessionId) : record;
  if (planRecord) {
    const { extractPlanContent } = await import('../session-history.js');
    const extracted = await extractPlanContent(planSessionId, planRecord.cwd, planRecord.host);
    if (extracted) {
      return {
        content: extracted,
        ...(planRecord.planFile ? { planFile: planRecord.planFile } : {}),
        ...(isFollowedLink ? { sourceSessionId: planSessionId } : {}),
      };
    }
  }

  throw new SessionControlError('No plan content found for this session', 404);
}

// ── Subagent lane history ────────────────────────────────────────────────────

/** agentId format: hex strings (Task subagents) or name@team (Team agents). */
const SUBAGENT_ID_RE = /^[a-zA-Z0-9_@.-]+$/;

/** Read one subagent lane's history (Task/Team layout, or the workflow layout). */
export async function getSubagentHistoryPayload(
  sessionId: string,
  agentId: string,
  isWorkflow: boolean,
): Promise<{ messages: unknown[] }> {
  if (!SUBAGENT_ID_RE.test(agentId)) {
    throw new SessionControlError('Invalid agentId format', 400);
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  const { readSingleSubagentHistory, rewriteHistoryRemoteImages } = await import('../session-history.js');
  let messages = await readSingleSubagentHistory(sessionId, agentId, record?.cwd, record?.host, isWorkflow);
  // Rewrite remote image paths for remote sessions.
  if (record?.host && messages.length > 0) {
    messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd);
  }
  return { messages };
}

// ── Execute-compact ──────────────────────────────────────────────────────────

export interface ExecuteCompactInput {
  task_id?: string;
  working_directory?: string;
  instructions?: string;
  mode?: string;
}

export interface ExecuteCompactResult {
  status: 'started';
  sessionId: string;
  strategy: 'compact';
  planSessionId: string;
  taskId?: string;
  mode: SessionMode;
  boundaryUuid: string;
}

/**
 * Execute a plan by injecting a compact boundary into the SAME session's JSONL
 * (clears the plan conversation but preserves session id, slug, and plan file)
 * then sending the plan-execution message. Avoids the "new session loses
 * codebase context" problem while clearing the 200+ plan messages.
 */
export async function executeCompactSession(
  sessionId: string,
  input: ExecuteCompactInput,
): Promise<ExecuteCompactResult> {
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  const sourceRecord = await getSessionByClaudeId(sessionId);
  if (!sourceRecord) throw new SessionControlError('Session not found', 404);

  // Follow one hop to the source plan session.
  let actualPlanSessionId = sessionId;
  if (sourceRecord.fromPlanSessionId && !sourceRecord.planCompleted) {
    actualPlanSessionId = sourceRecord.fromPlanSessionId;
  }

  // Read plan content (file first, JSONL extraction fallback).
  const { readPlanFromSession, buildPlanExecutionMessage } = await import('../../utils/plan-message.js');
  let planResult = await readPlanFromSession(actualPlanSessionId);
  if ('error' in planResult) {
    const planRecord = actualPlanSessionId !== sessionId
      ? await getSessionByClaudeId(actualPlanSessionId)
      : sourceRecord;
    if (planRecord) {
      const { extractPlanContent } = await import('../session-history.js');
      const extracted = await extractPlanContent(actualPlanSessionId, planRecord.cwd, planRecord.host);
      if (extracted?.trim()) {
        planResult = { content: extracted, planFile: planRecord.planFile ?? `(extracted from session ${actualPlanSessionId} JSONL)` };
      }
    }
  }
  if ('error' in planResult) {
    throw new SessionControlError(planResult.error, planResult.error.includes('not found') ? 404 : 400);
  }

  const taskId = input.task_id ?? sourceRecord.taskId;
  const cwd = input.working_directory ?? sourceRecord.cwd;
  if (!cwd) throw new SessionControlError('working_directory is required', 400);

  if (input.mode && !CLAUDE_SESSION_MODES.includes(input.mode as SessionMode)) {
    throw new SessionControlError(`Invalid mode: ${input.mode}. Must be one of: ${CLAUDE_SESSION_MODES.join(', ')}`, 400);
  }
  const execMode = (input.mode ?? 'bypass') as SessionMode;

  // Find the session's JSONL file (local-only strategy — remote plans use /execute).
  const { findLocalJsonlPath } = await import('../session-file-reader.js');
  const jsonlPath = await findLocalJsonlPath(actualPlanSessionId, cwd);
  if (!jsonlPath) {
    log.web.warn('execute-compact: JSONL not found, use /execute instead', { planSessionId: actualPlanSessionId, cwd });
    throw new SessionControlError('Could not find session JSONL file. Use /execute instead.', 400);
  }

  // Stop the session process if alive (must stop before JSONL injection).
  if (sourceRecord.process_status !== 'stopped') {
    log.web.info('execute-compact: stopping session process before injection', { planSessionId: actualPlanSessionId });
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const liveSession = sessionRunner.findByClaudeId(actualPlanSessionId);
    if (liveSession) {
      liveSession.interrupt();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Inject compact boundary + plan summary into the JSONL.
  const { injectCompactBoundary, buildCompactSummary } = await import('../../utils/compact-inject.js');
  const summary = buildCompactSummary(planResult.content, planResult.planFile);
  const injectResult = await injectCompactBoundary(jsonlPath, summary);
  if (!injectResult) {
    throw new SessionControlError('Failed to inject compact boundary into session JSONL', 500);
  }

  // Update session mode and send the execute message.
  await updateSessionRecord(actualPlanSessionId, { mode: execMode });
  const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, input.instructions);
  const { sendMessageToSession } = await import('../session-message-queue.js');
  await sendMessageToSession(actualPlanSessionId, planMessage, {
    source: 'web-api',
    taskId,
    mode: execMode,
  });

  log.web.info('execute-compact: injected boundary and sent execute message', {
    sessionId: actualPlanSessionId,
    boundaryUuid: injectResult.boundaryUuid,
    planFile: planResult.planFile,
  });

  return {
    status: 'started',
    sessionId: actualPlanSessionId,
    strategy: 'compact',
    planSessionId: actualPlanSessionId,
    taskId,
    mode: execMode,
    boundaryUuid: injectResult.boundaryUuid,
  };
}

// ── Queued-message management (WS session:get-queue/edit-queued/delete-queued twins) ──

/** List a session's pending/processing queued messages. */
export async function getSessionQueuePayload(sessionId: string): Promise<{ messages: unknown[] }> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  if (!(await getSessionByClaudeId(sessionId))) throw new SessionControlError('session not found', 404);
  const { getQueue } = await import('../session-message-queue.js');
  return { messages: await getQueue(sessionId) };
}

/** Edit a still-pending queued message's text. */
export async function editSessionQueuedMessage(
  sessionId: string,
  messageId: string,
  text: unknown,
): Promise<{ ok: true }> {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SessionControlError('text (non-empty string) is required', 400);
  }
  const { editMessage } = await import('../session-message-queue.js');
  const ok = await editMessage(sessionId, messageId, text);
  if (!ok) throw new SessionControlError('Message not editable (already processing or not found)', 409);
  return { ok: true };
}

/** Delete a still-pending queued message. */
export async function deleteSessionQueuedMessage(sessionId: string, messageId: string): Promise<{ ok: true }> {
  const { deleteMessage } = await import('../session-message-queue.js');
  const ok = await deleteMessage(sessionId, messageId);
  if (!ok) throw new SessionControlError('Message not deletable (already processing or not found)', 409);
  return { ok: true };
}

// ── Host directory listing (path picker auto-complete) ──────────────────────

/** In-memory cache for SSH directory listings (avoid re-SSHing for 60s). */
const dirCache = new Map<string, { dirs: string[]; exists: boolean; ts: number }>();
const DIR_CACHE_TTL = 60_000;
const LIST_DIRS_TIMEOUT_MS = 15_000;

export interface ListDirsResult {
  dirs: string[];
  parent: string;
  exists: boolean;
  cached?: boolean;
}

/**
 * List subdirectories on a host (local or daemon) for path auto-complete.
 * Remote hosts use DaemonConnection; results are cached briefly per host+dir.
 */
export async function listSessionDirs(
  rawPrefix: unknown,
  host: string | undefined,
  rawDepth: unknown,
): Promise<ListDirsResult> {
  const prefix = String(rawPrefix ?? '/');
  const depth = Math.min(Number(rawDepth) || 2, 4); // preload depth, default 2, max 4

  if (prefix.length > 4096) throw new SessionControlError('prefix too long', 400);
  // Sanitize: no shell metacharacters allowed in prefix.
  if (/[;&|`$(){}!<>]/.test(prefix)) throw new SessionControlError('invalid characters in prefix', 400);

  // Expand ~ to home directory (local only — the daemon's fs.ls expands remotely).
  let expandedPrefix = prefix;
  if ((expandedPrefix === '~' || expandedPrefix.startsWith('~/')) && !host) {
    const os = await import('node:os');
    // Preserve trailing slash: ~/ → /Users/me/, ~/foo → /Users/me/foo
    expandedPrefix = os.homedir() + expandedPrefix.slice(1);
  }

  // Find the parent directory to list. Partial matching is the frontend's job.
  const path = await import('node:path');
  const dir = expandedPrefix.endsWith('/') ? expandedPrefix : path.dirname(expandedPrefix);

  if (!host) {
    const listing = await listLocalDirs(dir, depth);
    return { dirs: listing.dirs, parent: listing.parent, exists: listing.exists };
  }

  // Remote: resolve host from config and use DaemonConnection.
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const hostDef = config.hosts?.[host];
  if (!hostDef) throw new SessionControlError(`Unknown host: ${host}`, 400);
  if (!hostDef.hostname) throw new SessionControlError(`Host "${host}" has no hostname`, 400);

  const cacheKey = `${host}::${dir}::${depth}`;
  const cached = dirCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
    return { dirs: cached.dirs, parent: dir, exists: cached.exists, cached: true };
  }

  const { getDaemonConnection } = await import('../../providers/daemon-connection.js');
  const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port };
  // Race against a timeout to cap HTTP request wait time; the failure cache in
  // daemon-connection.ts prevents retries for 60s after a failure.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new SessionControlError(`Remote connection to ${host} timed out`, 400)), LIST_DIRS_TIMEOUT_MS);
  });
  let conn;
  try {
    conn = await Promise.race([getDaemonConnection(host, sshTarget), timeoutPromise])
      .finally(() => clearTimeout(timeoutId!));
  } catch (err) {
    if (err instanceof SessionControlError) throw err;
    // SSH failures are client-visible 400s (matches the web route's contract).
    throw new SessionControlError(err instanceof Error ? err.message : String(err), 400);
  }

  // BFS listing via daemon fs.ls. ENOENT → exists:false (success); other
  // daemon/SSH errors throw and map to 400.
  let listing;
  try {
    listing = await listRemoteDirs(conn, dir, depth);
  } catch (err) {
    throw new SessionControlError(err instanceof Error ? err.message : String(err), 400);
  }

  // Cache results (also under the resolved path — the daemon may have expanded ~).
  const resolvedCacheKey = `${host}::${listing.parent}::${depth}`;
  dirCache.set(cacheKey, { dirs: listing.dirs, exists: listing.exists, ts: Date.now() });
  if (resolvedCacheKey !== cacheKey) {
    dirCache.set(resolvedCacheKey, { dirs: listing.dirs, exists: listing.exists, ts: Date.now() });
  }
  return { dirs: listing.dirs, parent: listing.parent, exists: listing.exists };
}
