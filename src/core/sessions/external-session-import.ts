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
 * Lifecycle of an imported task (all of it runs inside the SAME 10-minute tick;
 * there is no second timer and no model call anywhere in this file):
 *   - Type: every minted task carries EXTERNAL_SESSION_IMPORT_TAG. The web shows
 *     it as an "Imported" pill; the tag is what the rules below key on.
 *   - Folder: inside "Imported from <host>" the task sits in a sub-folder per
 *     working directory (label = the cwd's last two segments). Identity is the
 *     members' cwd, never the label. Old imports without a folder are backfilled
 *     a bounded number per tick, so an existing install converges on its own.
 *   - Title: a task whose title is a compaction summary or the minted fallback
 *     ("<Engine> session <id>") stays OUT of knownSessionIds, so the daemon keeps
 *     re-offering the session and the first tick that yields a real title
 *     renames the task in place (identity, notes, pins, phase all preserved).
 *   - Idle sweep: an imported task whose session has been idle for
 *     `auto_complete_after_days` (default 7) is auto-completed. Rolling: a task
 *     imported today is completed the tick it crosses the line, not before.
 *   - Adoption: the first message anyone sends to the session removes the tag
 *     (adoptImportedTask, called from the send handlers). The task keeps its
 *     project and folder but leaves the imported type: no pill, never swept.
 *
 * v1 grouped everything under one bucket task per host; that fought the 1-slot
 * model (sessions had to hide in session_ids history) and read as one opaque
 * row. cleanupLegacyBuckets() below removes those v1 buckets and lets the
 * normal scan re-import their sessions in this shape — one code path, no
 * bespoke migration of titles/timestamps.
 */

import os from 'node:os';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { isExcludedExternalCwd, isSyntheticUserText, type ExternalSessionCandidate } from '../../providers/external-session-scan-core.js';
import { ENGINE_REGISTRY, engineCaps, normalizeEngine } from '../agents/engine-registry.js';
import { EXTERNAL_SESSION_IMPORT_TAG, isExternalImportTask, type Task } from '../types.js';
import { readMarkerForPhase } from '../phase.js';

/** Daemon capability gating the scan RPC. */
const SCAN_CAPABILITY = 'external-scan-v1';
/** Daemon capability for re-reading specific transcripts by id (retitle of
 *  placeholder-titled imports whose files aged out of the scan window). */
const DESCRIBE_CAPABILITY = 'external-describe-v1';
/** Placeholder-titled sessions re-read per host per run. */
const RETITLE_LIMIT_PER_RUN = 100;
/** The scan walks directories on the host; give it room but never hang a tick. */
const SCAN_RPC_TIMEOUT_MS = 60_000;
/** Default lookback. Older transcripts are archaeology, not "sessions I'm using". */
export const DEFAULT_EXTERNAL_SCAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-host cap on candidates returned by one scan. */
const PER_HOST_CANDIDATE_LIMIT = 200;
/** Per-run cap on actual imports, so one huge backlog can't hog a tick. */
const PER_RUN_IMPORT_LIMIT = 100;
/** Per-run cap on idle auto-completions. Bounded so the first tick on an
 *  install with thousands of old imports drains them over a few ticks instead
 *  of one write storm; the web refreshes once per tick either way. */
const SWEEP_LIMIT_PER_RUN = 300;
/** Per-run cap on folder backfills for imports that predate cwd folders. */
const FOLDER_BACKFILL_LIMIT_PER_RUN = 300;
/** Idle window before an imported task is auto-completed (config override:
 *  external_session_import.auto_complete_after_days). */
export const DEFAULT_AUTO_COMPLETE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Marker tag on every imported task, so imports are identifiable and the v1
 *  bucket cleanup can find its targets. */
const HOLDER_TAG = EXTERNAL_SESSION_IMPORT_TAG;
// The CLI's title can arrive late: only a placeholder title is ever replaced,
// and the task is renamed in place, never rebuilt.
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

/**
 * A title this importer may still replace: the minted fallback ("Claude session
 * 1a2b3c4d") or text the scanner now knows is never a title (a compaction
 * summary, an injected preamble, a Walnut warm-up turn) that an older scanner
 * took for the first prompt. Anything else is treated as real and kept.
 */
export function isStaleImportTitle(title: string): boolean {
  return FALLBACK_TITLE_RE.test(title) || isSyntheticUserText(title);
}

/** Common home roots (macOS, Linux, and a "/local/home" layout) — collapsed to
 *  "~" so a remote cwd reads the way the user types it. */
const HOME_ROOT_RE = /^\/(?:Users|home|local\/home)\/[^/]+(?=\/|$)/;

/**
 * Folder label for a working directory: the last two path segments of the
 * home-collapsed path ("myCode/walnut", "src/server", "~/.claude").
 * Two segments keep sibling dirs with the same basename tellable apart; the
 * folder's identity is its members' full cwd, so a label collision never merges
 * two directories. `homeDir` is the scanning host's home when known (local).
 */
export function importFolderLabel(cwd: string, homeDir?: string): string {
  let collapsed = cwd.replace(/\/+$/, '') || '/';
  if (homeDir) {
    const home = homeDir.replace(/\/+$/, '');
    if (home && (collapsed === home || collapsed.startsWith(home + '/'))) {
      collapsed = '~' + collapsed.slice(home.length);
    }
  }
  if (!collapsed.startsWith('~')) collapsed = collapsed.replace(HOME_ROOT_RE, '~');
  const parts = collapsed.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  return parts.slice(-2).join('/');
}

export interface ExternalImportResult {
  /** Sessions newly imported into Walnut (each as its own task). */
  imported: number;
  /** Placeholder-titled tasks renamed in place this run. */
  retitled: number;
  /** Imported tasks auto-completed this run (idle past the window). */
  completed: number;
  /** Imports that predate cwd folders and were filed into one this run. */
  foldered: number;
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
async function scanTargets(excludedCwds: Record<string, string[]>): Promise<{ scannable: string[]; skipped: string[] }> {
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
    if (!conn || !conn.hasCapability(SCAN_CAPABILITY)) {
      skipped.push(host);
    } else if (excludedCwds[host]?.length && !conn.hasCapability('external-scan-filter-v1')) {
      skipped.push(host);
      log.session.info('external session scan requires daemon filter capability', { host });
    } else {
      scannable.push(host);
    }
  }
  return { scannable, skipped };
}

/** One host's scan. Returns [] on any failure — a bad host never fails the run. */
async function scanHost(
  host: string,
  knownSessionIds: string[],
  windowMs: number,
  excludedCwds: string[],
): Promise<{ candidates: ExternalSessionCandidate[]; truncated: boolean }> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  const conn = getConnectedDaemonConnection(host);
  if (!conn || !conn.hasCapability(SCAN_CAPABILITY)) return { candidates: [], truncated: false };
  try {
    const res = await conn.send('sessions.discoverExternal', {
      sinceMs: windowMs,
      knownSessionIds,
      excludedCwds,
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
async function cleanupLegacyBuckets(excludedCwds: Record<string, string[]>): Promise<number> {
  const { queryTasks, deleteTask, deleteProject } = await import('../task-manager.js');
  const { getSessionsForTask, deleteSessionRecords } = await import('../session-tracker.js');
  const buckets = (await queryTasks({ tagsAll: [HOLDER_TAG] }))
    .filter((t) => (t.tags ?? []).some((tag) => tag.startsWith(LEGACY_HOST_TAG_PREFIX)));
  if (buckets.length === 0) return 0;

  let cleaned = 0;
  for (const bucket of buckets) {
    const hosts = (bucket.tags ?? []).filter(tag => tag.startsWith(LEGACY_HOST_TAG_PREFIX))
      .map(tag => tag.slice(LEGACY_HOST_TAG_PREFIX.length));
    // An exclusion could block the re-import, so keep the bucket and its history.
    if (hosts.some(host => excludedCwds[host]?.length)) {
      log.session.info('legacy session bucket retained while host exclusions are configured', { taskId: bucket.id, hosts });
      continue;
    }
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

/** Does this session own the (stale) title on its task? A minted fallback names
 *  its session by id prefix; a synthetic-text title names none, so every
 *  session filed under the task qualifies (in practice exactly one). */
function sessionMayRetitle(title: string, sessionId: string): boolean {
  if (!isStaleImportTitle(title)) return false;
  if (FALLBACK_TITLE_RE.test(title)) return title.endsWith(` session ${sessionId.slice(0, 8)}`);
  return true;
}

// Completing a task clears its session slot, so the stale-title lookup goes
// through the session association (session.task_id), not the slot. Keyed by
// session id → host key ('__local__' for a record with no host).
async function retitleableSessions(): Promise<Map<string, string>> {
  const { queryTasks } = await import('../task-manager.js');
  const { getSessionsForTask } = await import('../session-tracker.js');
  const stuck = (await queryTasks({ tagsAll: [HOLDER_TAG] }))
    .filter((t) => isStaleImportTitle(t.title));
  const byId = new Map<string, string>();
  for (const task of stuck) {
    for (const session of await getSessionsForTask(task.id)) {
      if (sessionMayRetitle(task.title, session.claudeSessionId)) byId.set(session.claudeSessionId, session.host || '__local__');
    }
  }
  return byId;
}

/**
 * Ask one host about specific transcripts by id (no mtime window): full
 * descriptors for a retitle, or with activityOnly just each file's mtime.
 * Returns null when there is no answer (no connected daemon, no capability, a
 * failed call) so callers can tell "the file is gone" from "no evidence".
 */
async function describeHost(
  host: string,
  sessionIds: string[],
  activityOnly: boolean,
): Promise<{ candidates: ExternalSessionCandidate[]; activity: Map<string, number> } | null> {
  if (sessionIds.length === 0) return { candidates: [], activity: new Map() };
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  const conn = getConnectedDaemonConnection(host);
  if (!conn || !conn.hasCapability(DESCRIBE_CAPABILITY)) return null;
  try {
    const res = await conn.send('sessions.describeExternal', { sessionIds, activityOnly }, SCAN_RPC_TIMEOUT_MS);
    if (!res.ok) return null;
    const candidates = (Array.isArray(res.candidates) ? res.candidates as ExternalSessionCandidate[] : [])
      .filter((c) => c && typeof c.sessionId === 'string' && c.sessionId.length > 0);
    const activity = new Map<string, number>();
    for (const a of Array.isArray(res.activity) ? res.activity as Array<{ sessionId?: unknown; lastActiveAt?: unknown }> : []) {
      const at = typeof a?.lastActiveAt === 'string' ? Date.parse(a.lastActiveAt) : NaN;
      if (typeof a?.sessionId === 'string' && Number.isFinite(at)) activity.set(a.sessionId, at);
    }
    return { candidates, activity };
  } catch (err) {
    log.session.warn('external session describe failed for host', {
      host, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** When each placeholder-titled session was last re-read, so a run always asks
 *  for the least recently asked ones first and a transcript that can never
 *  yield a title does not starve the rest. Process memory is enough: a restart
 *  just starts the rotation over. */
const lastRetitleAsk = new Map<string, number>();

function pickRetitleBatch(ids: string[], limit: number, now: number): string[] {
  const batch = [...ids]
    .sort((a, b) => (lastRetitleAsk.get(a) ?? 0) - (lastRetitleAsk.get(b) ?? 0))
    .slice(0, limit);
  for (const id of batch) lastRetitleAsk.set(id, now);
  return batch;
}

// ── cwd folders ───────────────────────────────────────────────────────────

/** Per-run memo: project → (cwd → folder id). Filled lazily from EVERY task in
 *  the project with a cwd and a folder (adopted ones included: adoption keeps
 *  the filing), so identity is "the folder other sessions from this cwd are in"
 *  and a label collision can never merge two directories. */
type FolderIndex = Map<string, Map<string, string>>;

async function importFolderFor(
  index: FolderIndex,
  project: string,
  cwd: string,
  homeDir?: string,
): Promise<{ groupId: string; created: boolean }> {
  const { queryTasks, createFolder, listGroups } = await import('../task-manager.js');
  let byCwd = index.get(project);
  if (!byCwd) {
    byCwd = new Map();
    for (const t of await queryTasks({ projects: [project] })) {
      if (t.cwd && t.group_id && !byCwd.has(t.cwd)) byCwd.set(t.cwd, t.group_id);
    }
    index.set(project, byCwd);
  }
  const hit = byCwd.get(cwd);
  if (hit) return { groupId: hit, created: false };
  // A folder of this cwd whose members all left (deleted, moved) is still the
  // folder for it: reuse a same-label folder that holds nothing from any OTHER
  // directory rather than minting a twin.
  const label = importFolderLabel(cwd, homeDir);
  const { getTask } = await import('../task-manager.js');
  for (const g of await listGroups()) {
    if ((g.project ?? '').toLowerCase() !== project.toLowerCase() || g.label !== label || g.parent_id) continue;
    const members = await Promise.all(g.member_ids.map((id) => getTask(id).catch(() => null)));
    if (members.every((m) => !m || !m.cwd || m.cwd === cwd)) {
      byCwd.set(cwd, g.group_id);
      return { groupId: g.group_id, created: false };
    }
  }
  const created = await createFolder(label, project);
  byCwd.set(cwd, created.group_id);
  bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: created.group_id, label: created.label }, ['web-ui'], { source: 'external-session-import' });
  return { groupId: created.group_id, created: true };
}

/** File imports that predate cwd folders (or lost theirs) into the folder for
 *  their cwd. Only inside the per-host import projects: a task the user moved to
 *  a project of their own is filed the way they filed it. Bounded per run; a
 *  task with no recorded cwd stays at the project root (nothing to group by). */
async function backfillImportFolders(index: FolderIndex, imports: Task[], limit: number): Promise<number> {
  const { updateTaskRaw } = await import('../task-manager.js');
  const importProjects = await importProjectNames();
  const loose = imports.filter((t) => t.cwd && !t.group_id && !isLegacyBucket(t)
    && importProjects.has((t.project ?? '').toLowerCase()));
  let moved = 0;
  for (const task of loose.slice(0, limit)) {
    const cwd = task.cwd as string;
    const project = task.project ?? '';
    try {
      // The project name says which host: only the local one has a known home.
      const homeDir = project === externalImportProject('__local__') ? os.homedir() : undefined;
      const { groupId } = await importFolderFor(index, project, cwd, homeDir);
      const res = await updateTaskRaw(task.id, { group_id: groupId }, {
        emitEvent: false, push: false, source: 'external-session-import',
        shouldUpdate: (current) => isExternalImportTask(current) && !current.group_id
          && current.cwd === cwd && (current.project ?? '') === project,
      });
      if (res.changed) moved++;
    } catch (err) {
      log.session.warn('external import folder backfill failed', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return moved;
}

/** The per-host import projects this install can have (every configured host
 *  plus the local machine), whether or not a daemon is connected right now. */
async function importProjectNames(): Promise<Set<string>> {
  const names = new Set<string>([externalImportProject('__local__').toLowerCase()]);
  try {
    const { getConfig } = await import('../config-manager.js');
    for (const host of Object.keys((await getConfig()).hosts ?? {})) names.add(externalImportProject(host).toLowerCase());
  } catch { /* config unavailable — local project only */ }
  return names;
}

function isLegacyBucket(task: Task): boolean {
  return (task.tags ?? []).some((tag) => tag.startsWith(LEGACY_HOST_TAG_PREFIX));
}

// ── idle sweep ────────────────────────────────────────────────────────────

/** The imported session(s) behind a task and the newest recorded activity.
 *  The record's lastActiveAt is the transcript mtime at import time, refreshed
 *  by the sweep below whenever the host reports a newer one. */
async function importActivity(task: Task): Promise<{ sessions: Array<{ id: string; host: string }>; recorded: number }> {
  const { getSessionsForTask } = await import('../session-tracker.js');
  let recorded = 0;
  const sessions: Array<{ id: string; host: string }> = [];
  for (const s of await getSessionsForTask(task.id)) {
    sessions.push({ id: s.claudeSessionId, host: s.host || '__local__' });
    const at = Date.parse(s.lastActiveAt ?? '') || Date.parse(s.startedAt ?? '') || 0;
    if (at > recorded) recorded = at;
  }
  if (!recorded) recorded = Date.parse(task.last_session_update ?? '') || Date.parse(task.updated_at) || 0;
  return { sessions, recorded };
}

/**
 * Auto-complete imported tasks whose session has been idle past the window.
 *
 * Idle is judged on the transcript, not on the record: an imported session is
 * in knownSessionIds, so the scan never re-reads it, and a session someone keeps
 * using in a terminal would otherwise be "idle" a week after import. Every task
 * that looks due by its record is checked against its host (stat only, one RPC
 * per host); a newer mtime is written back to the session record and the task
 * stays open. No answer from the host (not connected, old daemon, failed call)
 * means no evidence, and nothing is completed for it this run. A transcript the
 * host no longer has is a dead session: the recorded clock stands.
 *
 * Oldest-idle first so a capped run always retires the longest-idle rows; the
 * remainder goes next tick. Raw writes with events off: the run emits ONE coarse
 * task:updated afterwards, which the web answers with a single refetch instead of
 * hundreds of row patches. Adopted tasks (tag gone) are not in `imports`, and a
 * task the user filed into a project of their own is theirs: only tasks still in
 * a per-host import project are swept.
 */
async function sweepIdleImports(imports: Task[], idleMs: number, now: number, limit: number): Promise<number> {
  if (!(idleMs > 0)) return 0;
  const { updateTaskRaw } = await import('../task-manager.js');
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  const importProjects = await importProjectNames();
  const due: Array<{ task: Task; recorded: number; sessions: Array<{ id: string; host: string }> }> = [];
  for (const task of imports) {
    if (task.phase === 'COMPLETE' || isLegacyBucket(task)) continue;
    if (!importProjects.has((task.project ?? '').toLowerCase())) continue;
    const { sessions, recorded } = await importActivity(task);
    if (recorded > 0 && now - recorded >= idleMs) due.push({ task, recorded, sessions });
  }
  due.sort((a, b) => a.recorded - b.recorded);
  const batch = due.slice(0, limit);

  // One stat-only RPC per host for every session behind the batch.
  const idsByHost = new Map<string, string[]>();
  for (const d of batch) for (const s of d.sessions) idsByHost.set(s.host, [...(idsByHost.get(s.host) ?? []), s.id]);
  const liveByHost = new Map<string, Map<string, number> | null>();
  for (const [host, ids] of idsByHost) liveByHost.set(host, (await describeHost(host, ids, true))?.activity ?? null);

  let completed = 0;
  const stamp = new Date(now).toISOString();
  for (const { task, recorded, sessions } of batch) {
    let latest = recorded;
    let evidence = sessions.length > 0;
    for (const s of sessions) {
      const live = liveByHost.get(s.host);
      if (live === null || live === undefined) { evidence = false; continue; }
      const at = live.get(s.id);
      if (at === undefined || at <= latest) continue;
      latest = at;
      // Keep the record honest so the next run needs no RPC to know it.
      await updateSessionRecordConditionally(s.id, {}, (current) => current.taskId === task.id,
        { setLastActiveAt: new Date(at).toISOString() }).catch(() => null);
    }
    if (!evidence || now - latest < idleMs) continue;
    try {
      const res = await updateTaskRaw(task.id, {
        phase: 'COMPLETE',
        completed_at: stamp,
        ...readMarkerForPhase('COMPLETE'),
        // Mirror applyPhase('COMPLETE'): a completed task holds no session slot.
        // null is the raw path's explicit-clear marker for a payload field.
        session_id: null as unknown as undefined,
      }, {
        emitEvent: false, push: false, source: 'external-session-import',
        shouldUpdate: (current) => isExternalImportTask(current) && current.phase !== 'COMPLETE'
          && (current.project ?? '') === (task.project ?? ''),
      });
      if (res.changed) completed++;
    } catch (err) {
      log.session.warn('external import idle sweep failed for task', {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return completed;
}

/**
 * Someone sent the session a message: the task is adopted and leaves the
 * imported type. Idempotent; a no-op for anything the importer never owned.
 * Called from the session send handlers next to the session:input phase hook.
 */
export async function adoptImportedTask(taskId: string, via: string): Promise<boolean> {
  const { getTask, updateTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task || !isExternalImportTask(task)) return false;
  // remove_tags is applied inside the task write lock against the row as it is
  // then, so a tag someone adds meanwhile survives; updateTask announces the
  // change as task:updated whatever the phase (never a second "completed").
  await updateTask(taskId, { remove_tags: [HOLDER_TAG] }, { source: 'external-session-import' });
  log.session.info('imported session adopted; task leaves the imported type', { taskId, via });
  return true;
}

async function importCandidate(
  candidate: ExternalSessionCandidate,
  host: string,
  folders: FolderIndex,
): Promise<'imported' | 'retitled' | 'skipped'> {
  const { getSessionByClaudeId, importSessionRecord, updateSessionRecordConditionally } =
    await import('../session-tracker.js');
  const { addTask, linkSession, getTask, updateTaskRaw } =
    await import('../task-manager.js');

  // Re-check under no lock: the scan list was built before any of this ran, and
  // a normal Walnut launch may have claimed the id in between.
  const existing = await getSessionByClaudeId(candidate.sessionId);
  if (existing) {
    if (!existing.taskId) return 'skipped';
    const owner = await getTask(existing.taskId).catch(() => null);
    if (!owner || !isExternalImportTask(owner) || !sessionMayRetitle(owner.title, candidate.sessionId)) return 'skipped';
    // A real title the session record already carries wins (it may have arrived
    // through another path); else the transcript's. Never trade one stale title
    // for another.
    const realTitle = (t: string | undefined): string | undefined =>
      t && t !== owner.title && !isStaleImportTitle(t) ? t : undefined;
    const title = realTitle(existing.title) ?? realTitle(candidate.title);
    if (!title) return 'skipped';
    const session = await updateSessionRecordConditionally(candidate.sessionId, { title },
      current => current.taskId === owner.id && current.title === existing.title,
      { preserveLastActiveAt: true });
    if (!session) return 'skipped';
    const updated = await updateTaskRaw(owner.id, { title }, {
      push: true,
      source: 'external-session-import',
      shouldUpdate: current => current.title === owner.title && isExternalImportTask(current),
    });
    // Announce as an update by hand: updateTaskRaw's own emit would call a
    // rename of an already-completed task "task:completed".
    if (updated.changed) {
      bus.emit(EventNames.TASK_UPDATED, { task: updated.task }, ['web-ui'], { source: 'external-session-import' });
    }
    return updated.changed ? 'retitled' : 'skipped';
  }

  const title = candidate.title && !isStaleImportTitle(candidate.title)
    ? candidate.title
    : `${engineCaps(candidate.engine).displayName} session ${candidate.sessionId.slice(0, 8)}`;
  const project = externalImportProject(host);
  const importedEngine = normalizeEngine(candidate.engine);
  // One sub-folder per working directory inside the host project; the local
  // host's home is known, so its labels collapse to "~/…".
  const folder = candidate.cwd
    ? await importFolderFor(folders, project, candidate.cwd, host === '__local__' ? os.homedir() : undefined)
    : undefined;
  const groupId = folder?.groupId;

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
    ...(groupId ? { group_id: groupId } : {}),
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
    const { deleteTask, deleteFolder, listGroups } = await import('../task-manager.js');
    try { await deleteTask(task.id); } catch { /* best-effort */ }
    // A folder minted for this very task would be left empty: remove it too.
    if (folder?.created) {
      try {
        const g = (await listGroups()).find((x) => x.group_id === folder.groupId);
        if (g && g.member_ids.length === 0) {
          await deleteFolder(folder.groupId);
          folders.get(project)?.delete(candidate.cwd as string);
        }
      } catch { /* best-effort */ }
    }
    log.session.debug('external session import skipped', {
      sessionId: candidate.sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return 'skipped';
  }

  await linkSession(task.id, candidate.sessionId);
  return 'imported';
}

// The REST trigger and the background tick share one queue so two overlapping
// runs can never mint the same task twice.
let importQueue: Promise<unknown> = Promise.resolve();

export interface ImportExternalSessionsOptions {
  windowMs?: number;
  /** Clock for the idle sweep (tests advance it; production leaves it unset). */
  now?: number;
  /** Per-run caps (test seam; production uses the module constants). */
  limits?: { sweep?: number; folderBackfill?: number; retitle?: number };
}

export function importExternalSessions(options: ImportExternalSessionsOptions = {}): Promise<ExternalImportResult> {
  const run = importQueue.then(() => runImport(options));
  importQueue = run.catch(() => {});
  return run;
}

async function runImport(options: ImportExternalSessionsOptions): Promise<ExternalImportResult> {
  const windowMs = options.windowMs ?? DEFAULT_EXTERNAL_SCAN_WINDOW_MS;
  const now = options.now ?? Date.now();
  const result: ExternalImportResult = {
    imported: 0, retitled: 0, completed: 0, foldered: 0, skipped: 0, hostsScanned: [], hostsSkipped: [],
    truncated: false, projectByHost: {}, cleanedLegacyBuckets: 0,
  };

  const { getConfig } = await import('../config-manager.js');
  const settings = (await getConfig()).external_session_import ?? {};
  const excludedCwds = settings.excluded_cwds ?? {};
  const idleMs = (settings.auto_complete_after_days ?? DEFAULT_AUTO_COMPLETE_AFTER_DAYS) * DAY_MS;
  const folders: FolderIndex = new Map();
  const { scannable, skipped } = await scanTargets(excludedCwds);
  result.hostsSkipped = skipped;

  if (scannable.length > 0) {
    await scanAndImport(scannable, {
      windowMs, excludedCwds, folders, retitleLimit: options.limits?.retitle ?? RETITLE_LIMIT_PER_RUN,
    }, result);
  }

  // Maintenance of what is already imported needs no daemon, so it runs even
  // when no host is warm: folders for old imports, then the idle sweep.
  const { queryTasks } = await import('../task-manager.js');
  const imports = await queryTasks({ tagsAll: [HOLDER_TAG] });
  result.foldered = await backfillImportFolders(folders, imports, options.limits?.folderBackfill ?? FOLDER_BACKFILL_LIMIT_PER_RUN);
  result.completed = await sweepIdleImports(imports, idleMs, now, options.limits?.sweep ?? SWEEP_LIMIT_PER_RUN);

  if (result.imported > 0 || result.retitled > 0 || result.completed > 0 || result.foldered > 0) {
    // One coarse refresh — addTask already emitted per-task events; this nudges
    // list surfaces that coalesce on task:updated (and is the ONLY signal for the
    // sweep/backfill writes, which deliberately emit nothing per row).
    bus.emit(EventNames.TASK_UPDATED, {}, [], { source: 'external-session-import' });
    log.session.info('imported external sessions', {
      imported: result.imported, retitled: result.retitled, completed: result.completed,
      foldered: result.foldered, skipped: result.skipped,
      hosts: result.hostsScanned.join(','),
      projects: Object.values(result.projectByHost).join(','),
    });
  }
  return result;
}

async function scanAndImport(
  scannable: string[],
  ctx: { windowMs: number; excludedCwds: Record<string, string[]>; folders: FolderIndex; retitleLimit: number },
  result: ExternalImportResult,
): Promise<void> {
  const { windowMs, excludedCwds, folders, retitleLimit } = ctx;
  // v1 buckets go first: dropping their session rows makes those ids unknown
  // again, so the scans below re-import them in the one-task-per-session shape.
  result.cleanedLegacyBuckets = await cleanupLegacyBuckets(excludedCwds);

  const { listAllSessionIds } = await import('../session-tracker.js');
  // Placeholder-titled imports stay OUT of knownSessionIds: the daemon re-offers
  // them each tick, and importCandidate upgrades one in place as soon as its
  // transcript yields a real title.
  const retitleable = await retitleableSessions();
  const knownSessionIds = [...await listAllSessionIds()].filter((id) => !retitleable.has(id));

  for (const host of scannable) {
    const hostExclusions = excludedCwds[host] ?? [];
    const scanned = await scanHost(host, knownSessionIds, windowMs, hostExclusions);
    result.hostsScanned.push(host);
    // Placeholder-titled sessions the window no longer reaches: ask for them by
    // id. Whatever the scan already offered is not asked for twice.
    const offered = new Set(scanned.candidates.map((c) => c.sessionId));
    const stale = [...retitleable].filter(([id, h]) => h === host && !offered.has(id)).map(([id]) => id);
    const described = await describeHost(host, pickRetitleBatch(stale, retitleLimit, Date.now()), false);
    const candidates = [...scanned.candidates, ...(described?.candidates ?? [])];
    const truncated = scanned.truncated;
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
        const outcome = isExcludedExternalCwd(candidate.cwd, hostExclusions)
          ? 'skipped' : await importCandidate(candidate, host, folders);
        result[outcome]++;
        if (outcome === 'imported') result.projectByHost[host] = externalImportProject(host);
      } catch (err) {
        result.skipped++;
        log.session.warn('external session import failed', {
          host, sessionId: candidate.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
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
