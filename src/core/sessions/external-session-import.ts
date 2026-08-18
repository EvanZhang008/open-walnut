/**
 * Automatic import of sessions started OUTSIDE Walnut.
 *
 * Why: a session opened by hand (`claude` in a terminal, Claude Desktop, the
 * codex TUI) is invisible to Walnut — no history view, no task link, no way to
 * resume it from the UI. This importer closes that gap without the human having
 * to notice and run `session_import` per session.
 *
 * Shape:
 *   1. Ask each connected daemon (local + every remote host) to scan ITS OWN
 *      transcript dirs. The walk + parse stay host-local by design — a host has
 *      thousands of transcript files and only a small descriptor list crosses
 *      the tunnel (see external-session-scan-core.ts).
 *   2. Drop anything Walnut already tracks (ids are sent to the daemon so it
 *      never even parses those files).
 *   3. Per host, ensure ONE holder task: "Sessions opened outside Walnut
 *      (<host>)". Every imported session for that host attaches to it.
 *   4. Import each candidate as a `stopped` session record with its real title.
 *
 * Deliberately NOT using linkSession(): that sets the task's single session slot
 * (1-session-per-task model). The holder task is a bucket for many sessions, so
 * imports go into `session_ids` history via addSessionToHistory() and leave the
 * slot empty — the slot is what "this task's live session" means, and a bucket
 * has no single live session.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import type { Task } from '../types.js';
import type { ExternalSessionCandidate } from '../../providers/external-session-scan-core.js';

/** Daemon capability gating the scan RPC. */
const SCAN_CAPABILITY = 'external-scan-v1';
/** The scan walks directories on the host; give it room but never hang a tick. */
const SCAN_RPC_TIMEOUT_MS = 60_000;
/** Default lookback. Older transcripts are archaeology, not "sessions I'm using". */
export const DEFAULT_EXTERNAL_SCAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-host cap on candidates returned by one scan. */
const PER_HOST_CANDIDATE_LIMIT = 200;
/** Per-run cap on actual imports, so one huge backlog can't hog a tick. */
const PER_RUN_IMPORT_LIMIT = 100;

/** Marker persisted on the holder task so we re-find it instead of duplicating. */
const HOLDER_TAG = 'walnut:external-sessions';

/**
 * Project the holder tasks live in. Deliberately a real project, NOT the Inbox:
 * one bucket task per host is exactly the "grouping layer" a project is for, and
 * in the Inbox they sit unlabeled among loose tasks where they're invisible.
 * Auto-created on first import (an unknown name mints a `source:'local'`
 * registry row), so a sync provider can never claim it.
 */
export const EXTERNAL_SESSIONS_PROJECT = 'Imported Sessions';

export interface ExternalImportResult {
  /** Sessions newly imported into Walnut. */
  imported: number;
  /** Candidates found but skipped (already tracked, or bad data). */
  skipped: number;
  /** Hosts actually scanned. */
  hostsScanned: string[];
  /** Hosts skipped because no connected daemon advertised the capability. */
  hostsSkipped: string[];
  /** True when a per-host or per-run cap clipped the work — logged, never silent. */
  truncated: boolean;
  /** Holder task id per host. */
  taskIdByHost: Record<string, string>;
}

/** Per-host marker tag, so the bucket survives a user rename of the title. */
function hostTag(host: string): string {
  return `walnut:host:${host}`;
}

/** Human-facing title of a host's holder task. */
export function externalHolderTaskTitle(host: string): string {
  return host === '__local__'
    ? 'Sessions opened outside Walnut (this Mac)'
    : `Sessions opened outside Walnut (${host})`;
}

/**
 * Hosts worth scanning: the local machine plus every host with a live pooled
 * daemon connection. Deliberately NEVER dials — an import tick must not pay SSH
 * connect costs, so a host that isn't warm is simply picked up on a later tick.
 */
async function scanTargets(): Promise<{ scannable: string[]; skipped: string[] }> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  const { getConfig } = await import('../config-manager.js');
  const hosts = new Set<string>(['__local__']);
  try {
    const config = await getConfig();
    for (const [name, entry] of Object.entries(config.hosts ?? {})) {
      // A disabled host is hidden from the UI; don't scan it either.
      if (entry && entry.enabled === false) continue;
      hosts.add(name);
    }
  } catch { /* config unavailable — local-only is still useful */ }

  const scannable: string[] = [];
  const skipped: string[] = [];
  for (const host of hosts) {
    const conn = getConnectedDaemonConnection(host);
    if (conn && conn.hasCapability(SCAN_CAPABILITY)) scannable.push(host);
    else skipped.push(host);
  }
  return { scannable, skipped };
}

/** One host's scan. Returns [] on any failure — a bad host never fails the run. */
async function scanHost(
  host: string,
  knownSessionIds: string[],
  windowMs: number,
): Promise<{ candidates: ExternalSessionCandidate[]; truncated: boolean }> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  const conn = getConnectedDaemonConnection(host);
  if (!conn || !conn.hasCapability(SCAN_CAPABILITY)) return { candidates: [], truncated: false };
  try {
    const res = await conn.send('sessions.discoverExternal', {
      sinceMs: windowMs,
      knownSessionIds,
      limit: PER_HOST_CANDIDATE_LIMIT,
    }, SCAN_RPC_TIMEOUT_MS);
    if (!res.ok || !Array.isArray(res.candidates)) return { candidates: [], truncated: false };
    const candidates = (res.candidates as ExternalSessionCandidate[])
      .filter((c) => c && typeof c.sessionId === 'string' && c.sessionId.length > 0);
    return { candidates, truncated: res.truncated === true };
  } catch (err) {
    log.session.warn('external session scan failed for host', {
      host, error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [], truncated: false };
  }
}

/**
 * Point every session already linked to a holder task at the task's project.
 * Best-effort: a failed row is logged and skipped, never fails the import.
 *
 * NOTE this is the one place the importer writes an EXISTING session record.
 * It only touches `project`, and only when it actually differs, so the
 * lastActiveAt bump inside updateSessionRecord can't rewrite a transcript's
 * real timestamps on a no-op tick.
 */
async function backfillSessionProject(task: Task): Promise<number> {
  const { getSessionsForTask, updateSessionRecord } = await import('../session-tracker.js');
  const project = task.project || '';
  let moved = 0;
  for (const session of await getSessionsForTask(task.id)) {
    if ((session.project || '') === project) continue;
    try {
      await updateSessionRecord(session.claudeSessionId, { project });
      moved++;
    } catch (err) {
      log.session.warn('external session project backfill failed', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (moved > 0) {
    log.session.info('backfilled project on imported sessions', { taskId: task.id, project, moved });
  }
  return moved;
}

/**
 * The host's existing holder task, or null. Matched by tag first, then by title,
 * so a user-renamed bucket is still recognized and we never mint a second one.
 * Includes COMPLETE tasks: a user who ticked the bucket off must not cause a
 * duplicate on the next tick.
 */
async function findHolderTask(host: string): Promise<Task | null> {
  const { queryTasks } = await import('../task-manager.js');
  const title = externalHolderTaskTitle(host);
  return (await queryTasks({ tagsAll: [HOLDER_TAG, hostTag(host)] }))[0]
    ?? (await queryTasks({ tagsAll: [HOLDER_TAG] })).find((t) => t.title === title)
    ?? null;
}

/**
 * Move a bucket that predates EXTERNAL_SESSIONS_PROJECT out of the Inbox, and
 * drag its already-imported session rows with it. A deliberate user move to some
 * OTHER project is respected — only the empty/Inbox case is corrected.
 */
async function healHolderProject(host: string, existing: Task): Promise<Task> {
  if (existing.project || '') return existing;
  const { updateTask } = await import('../task-manager.js');
  const { task } = await updateTask(existing.id, { project: EXTERNAL_SESSIONS_PROJECT });
  // Session rows carry their own `project` copy (search + filters read it), so
  // already-imported records must follow the task or the two disagree.
  await backfillSessionProject(task);
  log.session.info('moved external-session holder task out of the Inbox', {
    host, taskId: task.id, project: task.project,
  });
  return task;
}

/**
 * Heal an EXISTING bucket on a host that produced no new candidates this tick.
 * Returns null when the host has no bucket — a machine with no external sessions
 * must never grow an empty one.
 */
async function healExistingHolderTask(host: string): Promise<Task | null> {
  const existing = await findHolderTask(host);
  if (!existing) return null;
  return healHolderProject(host, existing);
}

/**
 * Find (or create) the holder task for a host.
 */
async function ensureHolderTask(host: string): Promise<Task> {
  const { addTask } = await import('../task-manager.js');
  const title = externalHolderTaskTitle(host);
  const existing = await findHolderTask(host);
  if (existing) return healHolderProject(host, existing);

  const { task } = await addTask({
    title,
    // A real project, not the Inbox: one bucket per host IS a grouping, and in
    // the Inbox these sit unlabeled among loose tasks where nobody finds them.
    project: EXTERNAL_SESSIONS_PROJECT,
    source: 'local',
    priority: 'none',
    tags: [HOLDER_TAG, hostTag(host)],
    description:
      'Auto-maintained by Walnut. Coding-agent sessions started outside Walnut on this ' +
      'machine (terminal `claude`, Claude Desktop, codex TUI) are imported here so they ' +
      'show up in the UI with their history. Safe to rename; do not delete unless you ' +
      'want the imports to start a fresh bucket.',
    _skipPluginOps: true,
  });
  log.session.info('created external-session holder task', {
    host, taskId: task.id, project: task.project,
  });
  return task;
}

/** Import one candidate. Returns true when a new record was written. */
async function importCandidate(
  candidate: ExternalSessionCandidate,
  host: string,
  task: Task,
): Promise<boolean> {
  const { getSessionByClaudeId, importSessionRecord } = await import('../session-tracker.js');
  const { addSessionToHistory } = await import('../task-manager.js');

  // Re-check under no lock: the scan list was built before any of this ran, and
  // a normal Walnut launch may have claimed the id in between.
  if (await getSessionByClaudeId(candidate.sessionId)) return false;

  const fallbackTitle = `${candidate.engine === 'codex' ? 'Codex' : 'Claude'} session ${candidate.sessionId.slice(0, 8)}`;
  try {
    await importSessionRecord({
      claudeSessionId: candidate.sessionId,
      taskId: task.id,
      project: task.project || '',
      ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
      // '__local__' is the in-memory key for "this machine"; session records
      // store local as absent host, so don't persist the sentinel.
      ...(host === '__local__' ? {} : { host }),
      title: candidate.title || fallbackTitle,
      ...(candidate.startedAt ? { startedAt: candidate.startedAt } : {}),
      lastActiveAt: candidate.lastActiveAt,
      messageCount: candidate.messageCount,
      // Set at CREATE time, never patched after: updateSessionRecord bumps
      // lastActiveAt on every write, which would replace the transcript's real
      // last-activity time with "now" and make every imported session sort as
      // if it had just been active.
      provider: 'cli',
      // engine drives which history reader the UI uses — a codex record read as
      // claude renders an empty transcript.
      ...(candidate.engine === 'codex' ? { engine: 'codex' as const } : {}),
      human_note: `Imported automatically — started outside Walnut (${candidate.origin}).`,
    });
  } catch (err) {
    // importSessionRecord throws on an id that raced in — treat as skipped.
    log.session.debug('external session import skipped', {
      sessionId: candidate.sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  await addSessionToHistory(task.id, candidate.sessionId);
  return true;
}

/**
 * Scan every reachable host and import whatever isn't tracked yet.
 * Never throws: a failing host degrades to "not scanned this tick".
 */
export async function importExternalSessions(options: {
  windowMs?: number;
} = {}): Promise<ExternalImportResult> {
  const windowMs = options.windowMs ?? DEFAULT_EXTERNAL_SCAN_WINDOW_MS;
  const result: ExternalImportResult = {
    imported: 0, skipped: 0, hostsScanned: [], hostsSkipped: [],
    truncated: false, taskIdByHost: {},
  };

  const { scannable, skipped } = await scanTargets();
  result.hostsSkipped = skipped;
  if (scannable.length === 0) return result;

  const { listAllSessionIds } = await import('../session-tracker.js');
  const knownSessionIds = [...await listAllSessionIds()];

  for (const host of scannable) {
    const { candidates, truncated } = await scanHost(host, knownSessionIds, windowMs);
    result.hostsScanned.push(host);
    if (truncated) {
      result.truncated = true;
      log.session.warn('external session scan hit the per-host cap', {
        host, limit: PER_HOST_CANDIDATE_LIMIT,
      });
    }
    if (candidates.length === 0) {
      // Nothing new to import, but an EXISTING bucket may still need healing
      // (e.g. it predates the project and is stranded in the Inbox). Steady
      // state is the common case — a host with no external sessions at all must
      // NOT grow an empty bucket, so this only touches a bucket that exists.
      const healed = await healExistingHolderTask(host);
      if (healed) result.taskIdByHost[host] = healed.id;
      continue;
    }

    // Only create the holder task once there is something to put in it — a
    // machine with no external sessions should not grow an empty bucket task.
    const task = await ensureHolderTask(host);
    result.taskIdByHost[host] = task.id;

    for (const candidate of candidates) {
      if (result.imported >= PER_RUN_IMPORT_LIMIT) {
        result.truncated = true;
        log.session.warn('external session import hit the per-run cap; remainder waits for the next tick', {
          host, limit: PER_RUN_IMPORT_LIMIT, remaining: candidates.length - result.imported,
        });
        break;
      }
      try {
        if (await importCandidate(candidate, host, task)) result.imported++;
        else result.skipped++;
      } catch (err) {
        result.skipped++;
        log.session.warn('external session import failed', {
          host, sessionId: candidate.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (result.imported > 0) {
    for (const taskId of Object.values(result.taskIdByHost)) {
      bus.emit(EventNames.TASK_UPDATED, { taskId }, [], { source: 'external-session-import' });
    }
    log.session.info('imported external sessions', {
      imported: result.imported, skipped: result.skipped,
      hosts: result.hostsScanned.join(','),
    });
  }
  return result;
}

// ── Periodic runner ───────────────────────────────────────────────────────
// setTimeout self-reschedule (not setInterval): the next tick is armed only
// after the current one finishes, so a slow host scan can never stack
// concurrent runs. First tick is delayed so it doesn't compete with the
// startup burst (health monitor, prewarmer, session recovery) — and so the
// daemon pool has time to warm, since we never dial.
const FIRST_TICK_DELAY_MS = 90_000;
const TICK_INTERVAL_MS = 10 * 60 * 1000;

export interface ExternalSessionImporterHandle {
  stop: () => Promise<void>;
  /** Run one import now (used by the manual REST trigger). */
  runNow: () => Promise<ExternalImportResult>;
}

/**
 * Start the background importer. Disable with WALNUT_EXTERNAL_SESSION_IMPORT=0.
 */
export function startExternalSessionImporter(): ExternalSessionImporterHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inflight: Promise<ExternalImportResult> | null = null;

  const runOnce = async (): Promise<ExternalImportResult> => {
    // Coalesce: a manual trigger during a tick joins that tick.
    if (inflight) return inflight;
    inflight = importExternalSessions().finally(() => { inflight = null; });
    return inflight;
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, delayMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    try {
      await runOnce();
    } catch (err) {
      log.session.warn('external session importer tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scheduleNext(TICK_INTERVAL_MS);
    }
  };

  if (process.env.WALNUT_EXTERNAL_SESSION_IMPORT === '0') {
    log.session.info('external session importer disabled by env');
    return { stop: async () => {}, runNow: runOnce };
  }

  scheduleNext(FIRST_TICK_DELAY_MS);
  log.session.info('external session importer started', { intervalMs: TICK_INTERVAL_MS });

  return {
    stop: async () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (inflight) { try { await inflight; } catch { /* already logged */ } }
    },
    runNow: runOnce,
  };
}
