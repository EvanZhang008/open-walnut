import path from 'node:path';
import fs from 'node:fs/promises';
import { SESSIONS_FILE, SESSIONS_DIR } from '../constants.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';
import { isProcessAlive } from '../utils/process.js';
import { log } from '../logging/index.js';
import type { SessionSummary, SessionRecord, SessionMode, Task } from './types.js';

// ── Triage detection ──

/** Agent IDs that are high-volume triage housekeeping — hidden from session UI. */
export const TRIAGE_AGENTS = new Set(['turn-complete-triage', 'message-send-triage']);

/**
 * Known triage agent display names (the `name` field from AgentDefinition).
 * Embedded session titles use format "{agentDef.name}: {task.slice(0,80)}",
 * so we match the prefix before the first colon against these patterns.
 */
const TRIAGE_NAME_PATTERNS = new Set([
  'Turn Complete Triage (onTurnComplete)',
  'Message Send Triage (onMessageSend)',
  // Legacy names from earlier agent definitions
  'Session Triage',
  'Turn Complete Triage',
  'Message Send Triage',
]);

/**
 * Returns true if a session record represents a triage subagent run (auto-triggered,
 * high-frequency). These should be hidden from the user-facing session list.
 * Checks both agent IDs and display names for robustness.
 */
export function isTriageSession(s: SessionRecord): boolean {
  if (s.provider !== 'embedded') return false;
  const prefix = s.title?.split(':')[0]?.trim() ?? '';
  return TRIAGE_AGENTS.has(prefix) || TRIAGE_NAME_PATTERNS.has(prefix);
}

// ── Store types ──

interface SessionStoreV2 {
  version: 2;
  sessions: SessionRecord[];
}

/**
 * Read store and auto-migrate legacy records.
 *
 * Legacy records with the old `status: 'active' | 'idle' | 'completed'` field
 * are migrated in-place to the new two-dimensional status model.
 */
async function readStore(): Promise<SessionStoreV2> {
  // Fresh fallback each call — readJsonFile returns the fallback by reference,
  // and callers mutate .sessions via push(), which would pollute a shared object.
  const raw = await readJsonFile<SessionStoreV2>(SESSIONS_FILE, { version: 2, sessions: [] });
  const store = raw as SessionStoreV2;
  store.version = 2;

  // Migrate legacy records that still have the old `status` field
  let migrated = false;
  for (const session of store.sessions) {
    const legacy = session as unknown as Record<string, unknown>;
    if ('status' in legacy && !('process_status' in legacy)) {
      const oldStatus = legacy.status as string;
      delete legacy.status;

      if (oldStatus === 'active') {
        session.process_status = 'stopped'; // can't verify PID during read — reconciler will fix
        session.work_status = 'in_progress';
      } else if (oldStatus === 'idle') {
        session.process_status = 'stopped';
        session.work_status = 'agent_complete';
      } else {
        session.process_status = 'stopped';
        session.work_status = 'completed';
      }

      session.mode ??= 'default';
      session.last_status_change ??= session.lastActiveAt;
      migrated = true;
    }
  }

  // Migrate renamed work_status values: turn_completed → agent_complete, pending_human_review → await_human_action
  for (const session of store.sessions) {
    const ws = (session as unknown as Record<string, unknown>).work_status as string;
    if (ws === 'turn_completed') {
      (session as unknown as Record<string, string>).work_status = 'agent_complete';
      migrated = true;
    } else if (ws === 'pending_human_review') {
      (session as unknown as Record<string, string>).work_status = 'await_human_action';
      migrated = true;
    }
  }

  // Migrate absorbed → archived + archive_reason (unified hidden-session model)
  for (const session of store.sessions) {
    const legacy = session as unknown as Record<string, unknown>;
    if (legacy.absorbed) {
      session.archived = true;
      session.archive_reason ??= 'plan_executed';
      delete legacy.absorbed;
      migrated = true;
    }
  }

  // Migrate process_status: running sessions that are not in_progress → idle
  // This handles the transition to the 3-state ProcessStatus model.
  for (const session of store.sessions) {
    if (session.process_status === 'running' && session.work_status !== 'in_progress') {
      (session as unknown as Record<string, string>).process_status = 'idle';
      session.last_status_change ??= session.lastActiveAt;
      migrated = true;
    }
  }

  if (migrated) {
    log.session.info('migrated legacy session records', { count: store.sessions.length });
    await writeStore(store);
  }

  return store;
}

async function writeStore(store: SessionStoreV2): Promise<void> {
  await writeJsonFile(SESSIONS_FILE, store);
}

// ── Write lock: serializes all read-modify-write operations ──
// Two layers: in-process promise chain + cross-process file lock.
// Prevents concurrent callers (session runner, health monitor, reconciler, hooks, REST)
// from overwriting each other's changes via stale snapshots.
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(() => withFileLock(SESSIONS_FILE, fn)).finally(() => resolve!());
}

/**
 * List all tracked sessions.
 */
export async function listSessions(): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions;
}

/**
 * Terminal work statuses — sessions in these states need no further monitoring.
 * completed = human confirmed done. error = something went wrong.
 */
export const TERMINAL_WORK_STATUSES = new Set(['completed', 'error']);

/**
 * List sessions that are not in a terminal state (for health monitor).
 */
export async function listNonTerminalSessions(): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions.filter(
    (s) => !TERMINAL_WORK_STATUSES.has(s.work_status) && !s.archived,
  );
}

/** Default session limits: local=7, any remote host=20. */
const DEFAULT_LOCAL_LIMIT = 7;
const DEFAULT_REMOTE_LIMIT = 20;

/** Default idle session limits per host (Layer 2). */
const DEFAULT_LOCAL_IDLE_LIMIT = 30;
const DEFAULT_REMOTE_IDLE_LIMIT = 40;

/**
 * Check if a session's OS process is actually alive.
 * SDK/embedded sessions trust process_status; CLI sessions verify via PID.
 * Returns false for anomalous records (no PID).
 *
 * Both 'running' and 'idle' mean the process is alive (idle = turn done, waiting for input).
 */
function isSessionProcessAlive(s: SessionRecord): boolean {
  // SDK and embedded sessions have no PID — trust process_status directly.
  // SDK: managed by session server. Embedded: in-process, managed by SubagentRunner.
  if (s.provider === 'sdk' || s.provider === 'embedded') return s.process_status !== 'stopped';
  if (s.pid == null) return false;
  const processName = s.host ? 'ssh' : 'claude';
  return isProcessAlive(s.pid, processName);
}

/**
 * Get actively-processing sessions grouped by host.
 * Only counts sessions with process_status='running' (actively processing a turn).
 * Idle sessions (turn complete, waiting for input) are NOT included.
 * These are the sessions actually consuming API/compute resources.
 *
 * Side-effect: any stale records (process alive in DB but PID dead)
 * are asynchronously corrected in sessions.json to prevent future
 * ghost-slot accumulation.
 */
export async function getActiveSessionsByHost(): Promise<Record<string, SessionRecord[]>> {
  const store = await readStore();
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: string[] = [];
  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status !== 'running') continue;
    if (!isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  }
  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }
  return result;
}

/**
 * Get all alive sessions grouped by host (both running and idle).
 * Includes idle sessions (turn complete, waiting for input).
 * Used for idle limit enforcement and diagnostics.
 *
 * Side-effect: any stale records (process alive in DB but PID dead)
 * are asynchronously corrected in sessions.json.
 */
export async function getAllAliveSessionsByHost(): Promise<Record<string, SessionRecord[]>> {
  const store = await readStore();
  const result: Record<string, SessionRecord[]> = {};
  const staleIds: string[] = [];
  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status === 'stopped') continue;  // only running + idle
    if (!isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    const key = s.host || 'local';
    (result[key] ??= []).push(s);
  }
  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }
  return result;
}

/**
 * Asynchronously correct stale session records whose process has exited
 * but process_status is still 'running'. Fire-and-forget — callers
 * don't need to wait for this; the returned results already exclude
 * these sessions.
 */
function fixStaleRecords(sessionIds: string[]): void {
  log.session.warn('fixing stale records', { count: sessionIds.length, ids: sessionIds });
  const now = new Date().toISOString();
  for (const id of sessionIds) {
    updateSessionRecord(id, {
      process_status: 'stopped',
      last_status_change: now,
    }).catch((err) => {
      log.session.warn('failed to fix stale record', { sessionId: id, error: String(err) });
    });
  }
}

/** @deprecated Use getActiveSessionsByHost() instead. */
export const getRunningSessionsByHost = getActiveSessionsByHost;

export interface SessionLimitResult {
  allowed: boolean;
  /** Current active (running) count for this host */
  running: number;
  /** Configured active limit for this host */
  limit: number;
  /** The active sessions on this host (for diagnostics) */
  runningSessions: SessionRecord[];
  /** Total alive processes on this host (running + idle) */
  totalAlive?: number;
  /** Current idle count for this host */
  idleCount?: number;
  /** Configured idle limit for this host */
  maxIdle?: number;
  /** Sessions that were auto-evicted to stay under the idle limit */
  evicted?: SessionRecord[];
}

/**
 * Check whether a new session can be started on the given host.
 *
 * Two-tier limit:
 *   1. Processing limit (per-host, default local=7): only running sessions count.
 *      Idle sessions do NOT block new work.
 *   2. Idle limit (per-host, default local=30, remote=40): cap on idle processes.
 *      When exceeded, the oldest idle session is gracefully stopped (SIGINT)
 *      to make room. Does NOT block new sessions.
 *
 * @param host — host alias from config.hosts, or undefined/null for local.
 * @param sessionLimits — the config.session_limits object (may be undefined).
 * @param sessionConfig — the config.session object (may be undefined).
 */
export async function checkSessionLimit(
  host: string | undefined | null,
  sessionLimits?: Record<string, number>,
  sessionConfig?: { idle_timeout_minutes?: number; max_idle?: number },
): Promise<SessionLimitResult> {
  const key = host || 'local';
  const rawLimit = sessionLimits?.[key]
    ?? (key === 'local' ? DEFAULT_LOCAL_LIMIT : DEFAULT_REMOTE_LIMIT);
  const limit = Math.max(1, rawLimit); // Floor at 1 to prevent zero/negative blocking all sessions

  // Idle limit: from config.session.max_idle, or per-host defaults
  const maxIdle = sessionConfig?.max_idle
    ?? (key === 'local' ? DEFAULT_LOCAL_IDLE_LIMIT : DEFAULT_REMOTE_IDLE_LIMIT);

  // Single store read — avoids double-read race and double PID-liveness scan.
  const store = await readStore();
  const runningSessions: SessionRecord[] = [];
  const idleSessions: SessionRecord[] = [];
  const staleIds: string[] = [];

  for (const s of store.sessions) {
    if (s.archived) continue;
    if (s.process_status === 'stopped') continue;
    if (!isSessionProcessAlive(s)) {
      staleIds.push(s.claudeSessionId);
      continue;
    }
    const sKey = s.host || 'local';
    if (sKey !== key) continue;
    if (s.process_status === 'running') {
      runningSessions.push(s);
    } else if (s.process_status === 'idle') {
      idleSessions.push(s);
    }
  }

  if (staleIds.length > 0) {
    fixStaleRecords(staleIds);
  }

  // Tier 2: idle limit — auto-evict oldest idle CLI sessions if exceeded
  const evicted: SessionRecord[] = [];

  if (maxIdle > 0 && idleSessions.length >= maxIdle) {
    // Only evict CLI sessions (they have PIDs we can SIGINT).
    // SDK/embedded sessions have no PID — evicting them has no effect on actual resources.
    const evictable = idleSessions
      .filter(s => s.provider !== 'sdk' && s.provider !== 'embedded')
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));

    const needToEvict = idleSessions.length - maxIdle + 1; // +1 to make room for one more
    for (let i = 0; i < needToEvict && i < evictable.length; i++) {
      const victim = evictable[i];
      log.session.warn('evicting idle session for capacity', { sessionId: victim.claudeSessionId, pid: victim.pid });
      if (victim.pid != null) {
        try { process.kill(victim.pid, 'SIGINT') } catch (err) { log.session.warn('SIGINT failed during eviction', { pid: victim.pid, error: String(err) }); }
      }
      await updateSessionRecord(victim.claudeSessionId, {
        process_status: 'stopped',
        work_status: victim.work_status === 'in_progress' ? 'agent_complete' : victim.work_status,
        activity: undefined,
        last_status_change: new Date().toISOString(),
      });
      evicted.push(victim);
    }
  }

  const allowed = runningSessions.length < limit;
  const totalAlive = runningSessions.length + idleSessions.length - evicted.length;
  log.session.info('session limit check', { host: key, running: runningSessions.length, limit, idle: idleSessions.length, maxIdle, allowed, totalAlive });

  return {
    allowed,
    running: runningSessions.length,
    limit,
    runningSessions,
    totalAlive,
    idleCount: idleSessions.length - evicted.length,
    maxIdle,
    evicted: evicted.length > 0 ? evicted : undefined,
  };
}

/**
 * Get a single session by Claude session ID.
 */
export async function getSessionByClaudeId(claudeSessionId: string): Promise<SessionRecord | null> {
  const store = await readStore();
  return store.sessions.find((s) => s.claudeSessionId === claudeSessionId) ?? null;
}

/**
 * Get all sessions linked to a task.
 */
export async function getSessionsForTask(taskId: string): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions.filter((s) => s.taskId === taskId);
}

/**
 * Create a new session record.
 */
export async function createSessionRecord(
  claudeSessionId: string,
  taskId: string,
  project: string,
  cwd?: string,
  extra?: { pid?: number; outputFile?: string; title?: string; description?: string; mode?: SessionMode; planFile?: string; planCompleted?: boolean; host?: string; provider?: import('./types.js').SessionProvider; fromPlanSessionId?: string; forkedFromSessionId?: string },
): Promise<SessionRecord> {
  return withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();

    // Check if a record with this Claude session ID already exists
    const existing = store.sessions.find((s) => s.claudeSessionId === claudeSessionId);
    if (existing) {
      existing.lastActiveAt = now;
      existing.messageCount++;
      if (cwd) existing.cwd = cwd;
      if (extra?.pid != null) {
        existing.pid = extra.pid;
        // Reset status when a new process starts (new PID = new process).
        // Always reset work_status — a new PID means the session was actively resumed,
        // even from terminal states (completed/error).
        if (existing.process_status !== 'running') {
          existing.process_status = 'running';
          existing.last_status_change = now;
        }
        existing.work_status = 'in_progress';
      }
      if (extra?.outputFile) existing.outputFile = extra.outputFile;
      if (extra?.mode) existing.mode = extra.mode;
      if (extra?.planFile) existing.planFile = extra.planFile;
      if (extra?.planCompleted != null) existing.planCompleted = extra.planCompleted;
      if (extra?.host) existing.host = extra.host;
      if (extra?.fromPlanSessionId) existing.fromPlanSessionId = extra.fromPlanSessionId;
      if (extra?.forkedFromSessionId) existing.forkedFromSessionId = extra.forkedFromSessionId;
      await writeStore(store);
      return existing;
    }

    const record: SessionRecord = {
      claudeSessionId,
      taskId,
      project,
      process_status: 'running',
      work_status: 'in_progress',
      mode: extra?.mode ?? 'default',
      last_status_change: now,
      startedAt: now,
      lastActiveAt: now,
      messageCount: 1,
      ...(cwd ? { cwd } : {}),
      ...(extra?.pid != null ? { pid: extra.pid } : {}),
      ...(extra?.outputFile ? { outputFile: extra.outputFile } : {}),
      ...(extra?.title ? { title: extra.title } : {}),
      ...(extra?.description ? { description: extra.description } : {}),
      ...(extra?.planFile ? { planFile: extra.planFile } : {}),
      ...(extra?.planCompleted != null ? { planCompleted: extra.planCompleted } : {}),
      ...(extra?.host ? { host: extra.host } : {}),
      ...(extra?.provider ? { provider: extra.provider } : {}),
      ...(extra?.fromPlanSessionId ? { fromPlanSessionId: extra.fromPlanSessionId } : {}),
      ...(extra?.forkedFromSessionId ? { forkedFromSessionId: extra.forkedFromSessionId } : {}),
    };

    store.sessions.push(record);
    await writeStore(store);
    log.session.info('session record created', { sessionId: claudeSessionId, taskId, project, mode: extra?.mode, host: extra?.host });
    return record;
  });
}

/**
 * Import an external session record (e.g. a `claude -p` session started outside Walnut).
 * Created directly as stopped — no running process to track.
 * Throws if a record with the same Claude session ID already exists.
 */
export async function importSessionRecord(opts: {
  claudeSessionId: string;
  taskId: string;
  project: string;
  cwd?: string;
  host?: string;
  title?: string;
  work_status?: 'agent_complete' | 'completed' | 'await_human_action';
  startedAt?: string;
  lastActiveAt?: string;
  messageCount?: number;
}): Promise<SessionRecord> {
  return withWriteLock(async () => {
    const store = await readStore();
    const existing = store.sessions.find((s) => s.claudeSessionId === opts.claudeSessionId);
    if (existing) {
      throw new Error(
        `Session ${opts.claudeSessionId} is already tracked (task: ${existing.taskId}). ` +
        `Use send_to_session to interact with it.`,
      );
    }

    const now = new Date().toISOString();
    const record: SessionRecord = {
      claudeSessionId: opts.claudeSessionId,
      taskId: opts.taskId,
      project: opts.project,
      process_status: 'stopped',
      work_status: opts.work_status ?? 'agent_complete',
      mode: 'default',
      last_status_change: now,
      startedAt: opts.startedAt ?? now,
      lastActiveAt: opts.lastActiveAt ?? now,
      messageCount: opts.messageCount ?? 0,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    };

    store.sessions.push(record);
    await writeStore(store);
    log.session.info('imported external session', {
      sessionId: opts.claudeSessionId,
      taskId: opts.taskId,
      project: opts.project,
      host: opts.host,
    });
    return record;
  });
}

/**
 * Update an existing session's fields.
 */
export async function updateSessionRecord(
  claudeSessionId: string,
  updates: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
): Promise<SessionRecord> {
  return withWriteLock(async () => {
    const store = await readStore();
    const session = store.sessions.find((s) => s.claudeSessionId === claudeSessionId);
    if (!session) {
      throw new Error(`Session not found: ${claudeSessionId}`);
    }

    Object.assign(session, updates);

    // When session reaches terminal state, clear PID to prevent stale PID orphan kills.
    // OS can recycle PIDs — a stale PID on a completed session can collide with a new session's PID.
    if (updates.work_status && TERMINAL_WORK_STATUSES.has(updates.work_status)) {
      session.pid = undefined;
    }
    session.lastActiveAt = new Date().toISOString();
    await writeStore(store);
    log.session.info('session record updated', { sessionId: claudeSessionId, fields: Object.keys(updates) });
    return session;
  });
}

/**
 * Rename a session's claudeSessionId — used when a --resume produces a different ID
 * than expected (resume failure). Updates the existing record in-place so history/UI
 * continuity is preserved. Returns the updated record, or null if not found.
 */
export async function renameSessionId(
  oldClaudeSessionId: string,
  newClaudeSessionId: string,
  updates?: Partial<Omit<SessionRecord, 'claudeSessionId'>>,
): Promise<SessionRecord | null> {
  return withWriteLock(async () => {
    const store = await readStore();
    const session = store.sessions.find((s) => s.claudeSessionId === oldClaudeSessionId);
    if (!session) return null;

    // Guard: if the new ID already exists on a different record, don't corrupt the store.
    // This would indicate a Claude CLI bug (two different sessions given the same ID).
    const conflict = store.sessions.find((s) => s.claudeSessionId === newClaudeSessionId && s !== session);
    if (conflict) {
      log.session.warn('renameSessionId: new ID already exists, skipping rename to avoid collision', {
        oldId: oldClaudeSessionId, newId: newClaudeSessionId,
      });
      return null;
    }

    session.claudeSessionId = newClaudeSessionId;
    if (updates) Object.assign(session, updates);
    session.lastActiveAt = new Date().toISOString();
    await writeStore(store);
    log.session.info('session ID renamed', { oldId: oldClaudeSessionId, newId: newClaudeSessionId });
    return session;
  });
}

/**
 * Link a session to a task ID.
 */
export async function linkSessionToTask(claudeSessionId: string, taskId: string): Promise<void> {
  await updateSessionRecord(claudeSessionId, { taskId });
}

/**
 * Mark all sessions in the given list as completed.
 * Skips sessions that are already in a terminal state (completed/error).
 * Also kills any orphaned OS processes (best-effort, fire-and-forget).
 * Returns the number of sessions actually updated.
 */
export async function completeTaskSessions(sessionIds: string[]): Promise<number> {
  if (!sessionIds.length) return 0;
  return withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    let updated = 0;
    const pidsToKill: number[] = [];
    for (const sid of sessionIds) {
      const session = store.sessions.find((s) => s.claudeSessionId === sid);
      if (!session) continue;
      if (TERMINAL_WORK_STATUSES.has(session.work_status)) continue;
      // Collect PIDs to kill (CLI sessions only — embedded/SDK have no OS process)
      if (session.pid != null && session.provider !== 'embedded' && session.provider !== 'sdk') {
        pidsToKill.push(session.pid);
      }
      session.work_status = 'completed';
      session.process_status = 'stopped';
      session.pid = undefined;  // Clear PID to prevent stale PID orphan kills
      session.last_status_change = now;
      session.lastActiveAt = now;
      updated++;
    }
    if (updated > 0) {
      await writeStore(store);
      log.session.info('completing task sessions', { sessionIds: sessionIds.join(','), count: updated });
      // Best-effort kill orphaned processes outside the write lock
      for (const pid of pidsToKill) {
        try { process.kill(pid, 'SIGINT'); } catch { /* already dead */ }
      }
    }
    return updated;
  });
}

/**
 * Check if a task's session slot is occupied by a non-terminal session.
 * Returns the SessionRecord if occupied, null if the slot is free.
 */
export async function getSlotSession(
  task: Task,
  slot: 'plan' | 'exec',
): Promise<SessionRecord | null> {
  const sessionId = slot === 'plan' ? task.plan_session_id : task.exec_session_id;
  if (!sessionId) return null;
  const rec = await getSessionByClaudeId(sessionId);
  // Slot is empty if the session no longer exists, has been archived, or has been fully completed/errored.
  if (!rec || rec.archived || rec.work_status === 'completed' || rec.work_status === 'error') return null;
  return rec;
}

/**
 * Get the active (alive) session for a task using the new 1-slot model.
 * Falls back to exec_session_id / plan_session_id for backward compat during migration.
 * Returns the session record if found and process is alive (running or idle), else null.
 */
export async function getActiveSession(task: Task): Promise<SessionRecord | null> {
  // Try new single slot first
  const candidates = [
    task.session_id,
    task.exec_session_id,
    task.plan_session_id,
  ].filter(Boolean) as string[];

  for (const sessionId of candidates) {
    const rec = await getSessionByClaudeId(sessionId);
    if (rec && !rec.archived && rec.process_status !== 'stopped') return rec;
  }
  return null;
}

/**
 * Get session summaries from markdown files in the sessions directory.
 */
export async function getSessionSummaries(limit = 10): Promise<SessionSummary[]> {
  await ensureDir(SESSIONS_DIR);

  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const mdFiles = files
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);

  const summaries: SessionSummary[] = [];
  for (const file of mdFiles) {
    try {
      const content = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8');
      const parsed = parseSessionMarkdown(content, file);
      if (parsed) summaries.push(parsed);
    } catch {
      // Skip unreadable files
    }
  }

  return summaries;
}

/**
 * Get recent tracked sessions, sorted by last active time.
 */
export async function getRecentSessions(limit = 10): Promise<SessionRecord[]> {
  const store = await readStore();
  return store.sessions
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, limit);
}

/**
 * Parse a session summary markdown file into a SessionSummary object.
 */
function parseSessionMarkdown(content: string, filename: string): SessionSummary | null {
  const lines = content.split('\n');
  const titleLine = lines.find((l) => l.startsWith('# Session:'));
  const dateLine = lines.find((l) => l.startsWith('Date:'));
  const projectLine = lines.find((l) => l.startsWith('Project:'));
  const statusLine = lines.find((l) => l.startsWith('Status:'));

  // Extract summary section
  const summaryIdx = lines.findIndex((l) => l.trim() === '## Summary');
  let summary = '';
  if (summaryIdx !== -1) {
    const nextSectionIdx = lines.findIndex(
      (l, i) => i > summaryIdx && l.startsWith('## '),
    );
    const end = nextSectionIdx === -1 ? lines.length : nextSectionIdx;
    summary = lines
      .slice(summaryIdx + 1, end)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
  }

  const slug = filename.replace(/\.md$/, '');

  return {
    id: slug,
    project: projectLine?.replace('Project:', '').trim() ?? 'unknown',
    slug,
    summary: summary || titleLine?.replace('# Session:', '').trim() || slug,
    status: statusLine?.replace('Status:', '').trim() ?? 'completed',
    date: dateLine?.replace('Date:', '').trim() ?? '',
    task_ids: [],
  };
}
