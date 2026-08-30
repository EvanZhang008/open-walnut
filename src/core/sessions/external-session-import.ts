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
 *   3. Per host, ONE PROJECT ("Imported from <host>"), and inside it ONE TASK
 *      PER SESSION, titled with the session's own auto-generated name. This is
 *      the normal task↔session shape (1 session per task, session in the slot),
 *      so imported sessions behave exactly like native ones — status circle,
 *      click-through, resume.
 *   4. Import each candidate as a `stopped` session record with its real title.
 *
 * v1 grouped everything under one bucket task per host; that fought the 1-slot
 * model (sessions had to hide in session_ids history) and read as one opaque
 * row. cleanupLegacyBuckets() below removes those v1 buckets and lets the
 * normal scan re-import their sessions in this shape — one code path, no
 * bespoke migration of titles/timestamps.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import type { Task } from '../types.js';
import type { ExternalSessionCandidate } from '../../providers/external-session-scan-core.js';
import { ENGINE_REGISTRY, engineCaps, normalizeEngine } from '../agents/engine-registry.js';

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

/** Marker tag on every imported task, so imports are identifiable and the v1
 *  bucket cleanup can find its targets. */
const HOLDER_TAG = 'walnut:external-sessions';
/** The name minted when a transcript yields no title. A HOLDER_TAG task still
 *  wearing it is re-title-eligible: its id is left out of knownSessionIds so
 *  the daemon re-offers it, and it's re-imported the moment a scan finally
 *  produces a real title (claude writes its ai-title AFTER the session starts,
 *  so "untitled at first sight" often resolves a tick later). */
const FALLBACK_TITLE_RE = new RegExp(
  `^(${[...ENGINE_REGISTRY.values()]
    // Same source as the minted title below (engineCaps().displayName), escaped
    // because a display name may carry regex metacharacters ("Custom (ACP)").
    .map((caps) => caps.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')}) session [0-9a-f]{8}$`,
);
/** v1-only per-host tag — its presence is what identifies a legacy bucket. */
const LEGACY_HOST_TAG_PREFIX = 'walnut:host:';
/** v1 project the buckets were filed under; removed once its buckets are gone. */
const LEGACY_PROJECT = 'Imported Sessions';

/**
 * Per-host project the imported tasks live in — the host IS the grouping
 * ("where did these come from"), so it's the project name. Auto-created on
 * first import (an unknown name mints a `source:'local'` registry row), so a
 * sync provider can never claim it.
 */
export function externalImportProject(host: string): string {
  return host === '__local__' ? 'Imported from this Mac' : `Imported from ${host}`;
}

export interface ExternalImportResult {
  /** Sessions newly imported into Walnut (each as its own task). */
  imported: number;
  /** Candidates found but skipped (already tracked, or bad data). */
  skipped: number;
  /** Hosts actually scanned. */
  hostsScanned: string[];
  /** Hosts skipped because no connected daemon advertised the capability. */
  hostsSkipped: string[];
  /** True when a per-host or per-run cap clipped the work — logged, never silent. */
  truncated: boolean;
  /** Project name per host that received imports this run. */
  projectByHost: Record<string, string>;
  /** v1 bucket tasks removed this run (their sessions re-import per-task). */
  cleanedLegacyBuckets: number;
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
 * Remove v1 holder-bucket tasks ("Sessions opened outside Walnut (<host>)") and
 * their session records, so the normal scan re-imports every one of those
 * sessions in the current one-task-per-session shape. Reuses the import path
 * instead of migrating in place — one code path, and titles/timestamps come
 * back from the transcripts (source of truth), not from the v1 rows.
 *
 * Identified by the v1-only per-host tag, NOT by title, so a task a user
 * created themselves can never be swept up. Runs on every tick; no-op once the
 * buckets are gone.
 */
async function cleanupLegacyBuckets(): Promise<number> {
  const { queryTasks, deleteTask, deleteProject } = await import('../task-manager.js');
  const { getSessionsForTask, deleteSessionRecords } = await import('../session-tracker.js');
  const buckets = (await queryTasks({ tagsAll: [HOLDER_TAG] }))
    .filter((t) => (t.tags ?? []).some((tag) => tag.startsWith(LEGACY_HOST_TAG_PREFIX)));
  if (buckets.length === 0) return 0;

  let cleaned = 0;
  for (const bucket of buckets) {
    try {
      // Drop the session rows FIRST: their ids must vanish from the tracker so
      // the next scan's knownSessionIds doesn't hide them from re-import.
      const sessions = await getSessionsForTask(bucket.id);
      await deleteSessionRecords(
        new Set(sessions.map((s) => s.claudeSessionId)),
        'external-import v1 bucket migration (re-imported as one task per session)',
      );
      await deleteTask(bucket.id);
      cleaned++;
      log.session.info('removed v1 external-session bucket (sessions re-import per-task)', {
        taskId: bucket.id, title: bucket.title, sessions: sessions.length,
      });
    } catch (err) {
      log.session.warn('v1 bucket cleanup failed; will retry next tick', {
        taskId: bucket.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Retire the v1 project once it's empty. Non-empty means the user filed their
  // own tasks there — leave it alone.
  try {
    const remaining = await queryTasks({ projects: [LEGACY_PROJECT] });
    if (remaining.length === 0) await deleteProject(LEGACY_PROJECT);
  } catch { /* project may not exist (fresh install) — fine */ }
  return cleaned;
}

/**
 * Session ids of imports stuck with the fallback name — the first scanner
 * version stopped reading an accepted SDK transcript at its entrypoint line,
 * before the first user message, so every SDK import was named
 * "Claude session <id>". These ids are LEFT OUT of the knownSessionIds sent to
 * the daemon, so it keeps re-offering them; importCandidate re-imports one the
 * moment a scan finally carries a real title, and simply skips it while the
 * transcript still yields none (no delete/re-import loop for truly untitled
 * sessions — the task stays put).
 */
async function fallbackNamedSessionIds(): Promise<Set<string>> {
  const { queryTasks } = await import('../task-manager.js');
  const stuck = (await queryTasks({ tagsAll: [HOLDER_TAG] }))
    .filter((t) => FALLBACK_TITLE_RE.test(t.title) && typeof t.session_id === 'string');
  return new Set(stuck.map((t) => t.session_id as string));
}

/** Import one candidate as ITS OWN task. Returns true when created. */
async function importCandidate(
  candidate: ExternalSessionCandidate,
  host: string,
): Promise<boolean> {
  const { getSessionByClaudeId, importSessionRecord, deleteSessionRecords } =
    await import('../session-tracker.js');
  const { addTask, linkSession, getTask, deleteTask, clearSessionSlot } =
    await import('../task-manager.js');

  // Re-check under no lock: the scan list was built before any of this ran, and
  // a normal Walnut launch may have claimed the id in between.
  const existing = await getSessionByClaudeId(candidate.sessionId);
  if (existing) {
    // Already imported under the fallback name and the transcript NOW yields a
    // real title (claude writes ai-title after the session starts) → re-import
    // through the normal path below so title/timestamps come from the
    // transcript. Anything else that's already tracked is skipped.
    if (!candidate.title || !existing.taskId) return false;
    const owner = await getTask(existing.taskId).catch(() => null);
    if (!owner || !(owner.tags ?? []).includes(HOLDER_TAG) || !FALLBACK_TITLE_RE.test(owner.title)) {
      return false;
    }
    await deleteSessionRecords(
      new Set([candidate.sessionId]),
      'external-import re-title (transcript now has a real title)',
    );
    // deleteTask refuses while the slot is occupied — clear it first (the
    // session record is already gone; the slot is the only remaining pointer).
    await clearSessionSlot(owner.id, candidate.sessionId);
    await deleteTask(owner.id);
  }

  const title = candidate.title
    || `${engineCaps(candidate.engine).displayName} session ${candidate.sessionId.slice(0, 8)}`;
  const project = externalImportProject(host);
  const importedEngine = normalizeEngine(candidate.engine);

  // Task title = the session's own auto-generated name. Normal 1-session-per-
  // task shape, so the session goes in the task's SLOT (linkSession), exactly
  // like a session Walnut started itself.
  const { task } = await addTask({
    title,
    project,
    source: 'local',
    priority: 'none',
    tags: [HOLDER_TAG],
    ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
    description: `Imported automatically — session started outside Walnut (${candidate.origin}).`,
    _skipPluginOps: true,
  });

  try {
    await importSessionRecord({
      claudeSessionId: candidate.sessionId,
      taskId: task.id,
      project,
      ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
      // '__local__' is the in-memory key for "this machine"; session records
      // store local as absent host, so don't persist the sentinel.
      ...(host === '__local__' ? {} : { host }),
      title,
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
      ...(importedEngine ? { engine: importedEngine } : {}),
      human_note: `Imported automatically — started outside Walnut (${candidate.origin}).`,
    });
  } catch (err) {
    // importSessionRecord throws on an id that raced in — remove the task we
    // just minted for it so a lost race can't leave an empty orphan behind.
    const { deleteTask } = await import('../task-manager.js');
    try { await deleteTask(task.id); } catch { /* best-effort */ }
    log.session.debug('external session import skipped', {
      sessionId: candidate.sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  await linkSession(task.id, candidate.sessionId);
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
    truncated: false, projectByHost: {}, cleanedLegacyBuckets: 0,
  };

  const { scannable, skipped } = await scanTargets();
  result.hostsSkipped = skipped;
  if (scannable.length === 0) return result;

  // v1 buckets go first: dropping their session rows makes those ids unknown
  // again, so the scans below re-import them in the one-task-per-session shape.
  result.cleanedLegacyBuckets = await cleanupLegacyBuckets();

  const { listAllSessionIds } = await import('../session-tracker.js');
  // Fallback-named imports stay OUT of knownSessionIds: the daemon re-offers
  // them each tick, and importCandidate upgrades one in place as soon as its
  // transcript yields a real title.
  const retitleable = await fallbackNamedSessionIds();
  const knownSessionIds = [...await listAllSessionIds()].filter((id) => !retitleable.has(id));

  for (const host of scannable) {
    const { candidates, truncated } = await scanHost(host, knownSessionIds, windowMs);
    result.hostsScanned.push(host);
    if (truncated) {
      result.truncated = true;
      log.session.warn('external session scan hit the per-host cap', {
        host, limit: PER_HOST_CANDIDATE_LIMIT,
      });
    }
    if (candidates.length === 0) continue;

    for (const candidate of candidates) {
      if (result.imported >= PER_RUN_IMPORT_LIMIT) {
        result.truncated = true;
        log.session.warn('external session import hit the per-run cap; remainder waits for the next tick', {
          host, limit: PER_RUN_IMPORT_LIMIT, remaining: candidates.length - result.imported,
        });
        break;
      }
      try {
        if (await importCandidate(candidate, host)) {
          result.imported++;
          result.projectByHost[host] = externalImportProject(host);
        } else {
          result.skipped++;
        }
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
    // One coarse refresh — addTask already emitted per-task events; this nudges
    // list surfaces that coalesce on task:updated.
    bus.emit(EventNames.TASK_UPDATED, {}, [], { source: 'external-session-import' });
    log.session.info('imported external sessions', {
      imported: result.imported, skipped: result.skipped,
      hosts: result.hostsScanned.join(','),
      projects: Object.values(result.projectByHost).join(','),
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
