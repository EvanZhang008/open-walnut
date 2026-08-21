#!/usr/bin/env node
/**
 * Repair sessions whose `task_id` points at a task that no longer exists.
 *
 * Symptom: a session with a dangling `sessions.task_id` is INVISIBLE on every
 * task surface. `enrichTasksWithSessionStatus` (src/web/routes/tasks.ts) builds
 * a reverse map `sessions.task_id -> task` at read time, so a pointer at a dead
 * id simply never joins. A 2026-08-20 sweep found 254 such sessions on one
 * install, including one with 1032 messages.
 *
 * Two distinct bugs produce them:
 *
 *   (A) Task deletion did not clear `sessions.task_id`. Fixed separately by
 *       `unlinkSessionsFromTasks()` in src/core/session-tracker.ts.
 *
 *   (B) DUPLICATE task rows get created for the same remote item, and then one
 *       of the twins is deleted. `sync-reconciler.ts` builds its remote-id join
 *       map from `ctx.getTasks().filter(t => t.source === plugin.id)` — a
 *       source-filtered list. When a task's `source` drifts, the plugin stops
 *       seeing its own row, treats the remote item as new, and inserts a SECOND
 *       row with a fresh local id; the original later looks "not in remote" and
 *       is removed. See _docs/duplicate-task-rows-root-cause.md. This is why the
 *       repair below can find a live twin at all: the work still exists under a
 *       new id.
 *
 * WHY only `sessions.task_id` is written for the repointing case: the task's
 * `session_ids` is rebuilt at read time (verified live), so the column update
 * alone restores visibility. That keeps this script out of tasks.sqlite entirely
 * except for the opt-in `--create-holding` inserts.
 *
 * Safety properties:
 *   - Never deletes a row. Every action is a column UPDATE (or an INSERT for
 *     holding tasks).
 *   - Every write carries `AND task_id = ?`, so a row that changed underneath us
 *     is a no-op rather than a clobber. That also makes re-runs idempotent.
 *   - Classification is rebuilt from scratch on every invocation (no cached
 *     artifact), so the script stays correct as the orphan set shrinks.
 *   - `task_id` is an explicit column, never spilled into `payload` by
 *     sessionToRow, and is not part of the status projection — so a raw column
 *     UPDATE bypasses no invariant. Same reasoning as unlinkSessionsFromTasks.
 *   - The server's caches are `PRAGMA data_version` guarded, so it notices an
 *     outside write and refetches. No restart needed.
 *
 * Nothing install-specific is hardcoded here: generic titles, sync provider
 * names and holding-task titles are all derived from the data at runtime (see
 * `deriveGenericTitles`, `remoteIdOf`, `holdingTitleFor`). Per-install
 * overrides can live in an uncommitted JSON file — see OVERRIDES_FILE.
 *
 * Usage:
 *   node scripts/repair-orphan-session-links.mjs                          # dry-run
 *   node scripts/repair-orphan-session-links.mjs --apply                  # buckets A, C, D
 *   node scripts/repair-orphan-session-links.mjs --apply --create-holding # also bucket B
 *   node scripts/repair-orphan-session-links.mjs --verify                 # re-count only
 */
import Database from '../node_modules/better-sqlite3/lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const CREATE_HOLDING = process.argv.includes('--create-holding');
const VERIFY_ONLY = process.argv.includes('--verify');

const DATA_DIR = process.env.WALNUT_DATA_DIR || path.join(os.homedir(), '.open-walnut');
const SESSIONS_DB = path.join(DATA_DIR, 'sessions.sqlite');
const TASKS_DB = path.join(DATA_DIR, 'tasks', 'tasks.sqlite');

/**
 * Optional, uncommitted, per-install overrides. Lives in the DATA dir (not the
 * repo) precisely so install-specific strings never enter version control.
 *
 *   {
 *     "skipSessions":  ["<session-id-prefix>", ...],   // already fixed by hand
 *     "holdingTitles": { "<dead-task-id>": "Title" }   // bucket B naming
 *   }
 */
const OVERRIDES_FILE = path.join(DATA_DIR, 'orphan-repair-overrides.json');
let overrides = { skipSessions: [], holdingTitles: {} };
if (fs.existsSync(OVERRIDES_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    overrides = {
      skipSessions: Array.isArray(parsed.skipSessions) ? parsed.skipSessions : [],
      holdingTitles: parsed.holdingTitles && typeof parsed.holdingTitles === 'object'
        ? parsed.holdingTitles : {},
    };
  } catch (err) {
    console.error(`overrides file is not valid JSON, refusing to guess: ${OVERRIDES_FILE}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

/** Same id shape as generateId() in src/utils/format.ts: base36 ms + 4 hex. */
function generateId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

// ── Read helpers ───────────────────────────────────────────────────────────

function openRo(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/**
 * Normalized title for join purposes. Fork prefixes are stripped because a sync
 * round-trip re-titles a forked task ("Fork of X", "Hi - fork of X"), so the
 * surviving twin and the dead row often differ only by that prefix.
 */
function normTitle(s) {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^((fork of|i need more context - fork of|hi - fork of|code review request - fork of) )+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Titles that carry no identifying information, derived from the data instead of
 * a hardcoded list (which would bake one install's directory names into a public
 * repo, and would silently miss any new ones).
 *
 * Two rules:
 *   1. A normalized title shared by >= GENERIC_TITLE_MIN_SHARE live tasks cannot
 *      identify one of them. On real data "session: <dirname>" style titles hit
 *      19 live candidates each.
 *   2. Auto-generated session titles ("Session: <cwd basename>", "New Chat", or
 *      empty) are never a join key even when currently unique, because the next
 *      session opened in the same directory produces the identical string.
 */
const GENERIC_TITLE_MIN_SHARE = 2;
const AUTO_TITLE_RE = /^(session:\s*\S*|new chat|main ai chat|imported session\b.*)$/;

function deriveGenericTitles(liveTasks, deadRecords) {
  const freq = new Map();
  for (const t of liveTasks) {
    const n = normTitle(t.title);
    freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  const generic = new Set(['']);
  for (const [n, count] of freq) if (count >= GENERIC_TITLE_MIN_SHARE) generic.add(n);
  // Auto-generated shapes on either side of the join are unusable regardless of
  // how many live tasks currently share them.
  for (const src of [liveTasks, [...deadRecords.values()]]) {
    for (const t of src) {
      const n = normTitle(t.title);
      if (AUTO_TITLE_RE.test(n)) generic.add(n);
    }
  }
  return generic;
}

/**
 * External sync id from a task's `ext` JSON, as `<provider>:<id>`.
 *
 * Provider keys are read from the object itself rather than matched against a
 * fixed list, so this works for any installed sync plugin (and keeps plugin
 * names out of the source). Every plugin stores its remote key under one of
 * id / short_id / issue_key — see the `idx_tasks_ext_*` indexes in task-db.ts.
 */
const REMOTE_KEY_FIELDS = ['id', 'short_id', 'issue_key'];

function remoteIdOf(extJson) {
  if (!extJson) return null;
  let ej;
  try { ej = JSON.parse(extJson); } catch { return null; }
  if (!ej || typeof ej !== 'object') return null;
  for (const [provider, v] of Object.entries(ej)) {
    if (!v || typeof v !== 'object') continue;
    for (const field of REMOTE_KEY_FIELDS) {
      if (typeof v[field] === 'string' && v[field]) return `${provider}:${v[field]}`;
    }
  }
  return null;
}

/**
 * Recover DELETED task rows (title/project/source/ext) from every historical
 * store still on disk. Matching a dead id to a live twin requires knowing what
 * the dead task WAS.
 *
 * Two source families, newest first:
 *   - `tasks/*.backup` and `tasks/tasks.pre-*.sqlite` — full SQLite snapshots
 *     taken before past migrations/repairs. These carry `ext`, which enables the
 *     strongest (remote-id) match.
 *   - `tasks/tasks.json` revisions in the DATA_DIR git repo — reaches further
 *     back than any snapshot, but pre-dates `ext` on most rows.
 *
 * First writer wins per id, so the record closest to the deletion is kept.
 */
function recoverDeletedTasks(deadIds) {
  const out = new Map();
  const wanted = new Set(deadIds);
  const tasksDir = path.join(DATA_DIR, 'tasks');

  // Discovered, not hardcoded: snapshot names differ per install and accumulate
  // over time. Newest mtime first == closest to the deletion.
  let snapshots = [];
  try {
    snapshots = fs.readdirSync(tasksDir)
      .filter((f) => /\.backup$/.test(f) || /^tasks\..+\.sqlite$/.test(f))
      .filter((f) => !/-(shm|wal)$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(tasksDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  } catch { /* no snapshots is survivable — we fall through to git history */ }

  for (const name of snapshots) {
    let db;
    try { db = openRo(path.join(tasksDir, name)); } catch { continue; }
    try {
      for (const r of db.prepare('SELECT id, title, project, source, phase, ext FROM tasks').iterate()) {
        if (wanted.has(r.id) && !out.has(r.id)) out.set(r.id, { ...r, from: name });
      }
    } catch { /* older schema or empty file — skip */ }
    db.close();
  }

  // tasks.json history. `git show` can be blocked by a tool sandbox; `cat-file
  // -p` is the portable form. Failure is non-fatal, it only costs us reach.
  try {
    const revs = execFileSync('git', ['-C', DATA_DIR, 'log', '--format=%h', '--', 'tasks/tasks.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    for (const rev of revs) {
      let raw;
      try {
        raw = execFileSync('git', ['-C', DATA_DIR, 'cat-file', '-p', `${rev}:tasks/tasks.json`],
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { continue; }
      if (!raw.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
      if (!Array.isArray(tasks)) continue;
      for (const t of tasks) {
        if (wanted.has(t.id) && !out.has(t.id)) {
          out.set(t.id, {
            id: t.id, title: t.title, project: t.project, source: t.source,
            phase: t.phase, ext: t.ext ? JSON.stringify(t.ext) : null,
            from: `tasks.json@${rev}`,
          });
        }
      }
    }
  } catch {
    console.warn('  (tasks.json git history unavailable — snapshot recovery only)');
  }

  return out;
}

// ── Throwaway detection ────────────────────────────────────────────────────

/**
 * Markers identifying a session as disposable test traffic. These are the fixed
 * strings the live/E2E suites ask the CLI to echo back, plus the shapes a
 * scripted probe produces — read off a real orphan set rather than guessed.
 */
const THROWAWAY_PATTERNS = [
  /\bpong\b/i, /\bping\b/i, /CONCURRENT-\d/, /BURST-/, /LIVE-JOURNEY/,
  /PROD-UI-OK/, /CONTROLS-TEST/, /FINAL-CHECK/, /LOGIN_OK/, /BRIDGE-OK/,
  /DEFAULT-MODE-CHECK/, /catalog-rebuild-ok/, /REST_IN/,
  /say hi only/i, /say hi and nothing else/i, /^say ok\b/i,
  /reply with (just|exactly)/i, /echo hello/i, /hello world/i, /^test$/i,
  /pure test/i, /no-?op/i, /\bdummy\b/i, /\bsmoke\b/i, /endurance/i,
  /THIS IS A TEST/i, /verify instant panel/i, /test pending panel/i,
  /permission-prompt-tool/i, /ready check/i, /connectivity test/i,
  /attached-images/i, /from verify script/i, /curl test with full meta/i,
  /prod verify \d{10,}/i, /^run th(is|ese) (exact|shell)/i,
  /model id, then stop/i, /测试消息/, /测试字符串/, /固定字符串/, /问好测试/,
];

/**
 * Temp/scratch working directories. A session rooted here was started by a test
 * harness or a throwaway probe, never by real work.
 */
const SCRATCH_CWD_RE = /^\/(tmp|private\/tmp|var\/folders)\//;

function throwawayReason(sess, genericTitles) {
  const title = sess.title ?? '';
  const cwd = sess.cwd ?? '';
  for (const p of THROWAWAY_PATTERNS) if (p.test(title)) return `test marker ${p}`;
  // A scratch cwd alone is not proof (real debugging happens in /tmp), so it
  // only counts when the session also carries no distinguishing title and
  // essentially no content.
  if ((SCRATCH_CWD_RE.test(cwd) || cwd === '/tmp')
    && (sess.message_count ?? 0) <= 2
    && genericTitles.has(normTitle(title))) {
    return 'scratch cwd, no content';
  }
  return null;
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Minimum shared-prefix length for the truncation match. A sync round-trip can
 * clip a long title, so the live twin may be a strict prefix of the dead one.
 * 40 chars is long enough that versioned sibling titles ("… test v17" vs
 * "… test v18") do not collide; shorter bounds matched them to each other.
 */
const MIN_PREFIX_MATCH = 40;

function sharedPrefixLen(a, b) {
  const x = normTitle(a), y = normTitle(b);
  let i = 0;
  while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
  return i;
}

/** Message count at or above which an unmatched session counts as real content. */
const REAL_CONTENT_MIN_MESSAGES = 10;

function classify({ orphans, liveTasks, recovered, genericTitles, skipSessions }) {
  const byRemoteId = new Map();
  const byTitle = new Map();
  for (const t of liveTasks) {
    const rid = remoteIdOf(t.ext);
    if (rid) {
      if (!byRemoteId.has(rid)) byRemoteId.set(rid, []);
      byRemoteId.get(rid).push(t);
    }
    const n = normTitle(t.title);
    if (!byTitle.has(n)) byTitle.set(n, []);
    byTitle.get(n).push(t);
  }

  const rows = [];
  for (const sess of orphans) {
    if (skipSessions.some((p) => sess.claude_session_id.startsWith(p))) continue;

    const dead = recovered.get(sess.task_id) ?? null;
    const deadUsableTitle = dead?.title && !genericTitles.has(normTitle(dead.title))
      ? dead.title : null;
    let candidates = [];
    let how = null;

    // 1. External sync id. Strongest signal: an exact hit proves both rows
    //    describe the SAME remote item, which is bug B's exact signature.
    if (dead?.ext) {
      const rid = remoteIdOf(dead.ext);
      if (rid && byRemoteId.has(rid)) { candidates = byRemoteId.get(rid); how = 'remote-id'; }
    }
    // 2. Exact normalized title (generic titles excluded above).
    if (!how && deadUsableTitle) {
      const hits = byTitle.get(normTitle(deadUsableTitle));
      if (hits) { candidates = hits; how = 'title-exact'; }
    }
    // 3. Long shared prefix — the surviving row's title was truncated.
    if (!how && deadUsableTitle && normTitle(deadUsableTitle).length >= MIN_PREFIX_MATCH) {
      const hits = liveTasks.filter((t) => {
        if (sharedPrefixLen(deadUsableTitle, t.title) < MIN_PREFIX_MATCH) return false;
        const a = normTitle(deadUsableTitle), b = normTitle(t.title);
        return a.startsWith(b) || b.startsWith(a);
      });
      if (hits.length) { candidates = hits; how = 'title-truncation'; }
    }

    const tw = throwawayReason(sess, genericTitles);
    let bucket;
    if (how && candidates.length === 1) bucket = 'A';
    else if (how && candidates.length > 1) bucket = 'A?';
    else if (tw) bucket = 'C';
    else if ((sess.message_count ?? 0) >= REAL_CONTENT_MIN_MESSAGES) bucket = 'B';
    else bucket = 'D';

    rows.push({
      sid: sess.claude_session_id,
      old_task_id: sess.task_id,
      bucket,
      how,
      new_task_id: bucket === 'A' ? candidates[0].id : null,
      new_task_title: bucket === 'A' ? candidates[0].title : null,
      ambiguous_candidates: bucket === 'A?' ? candidates.map((c) => c.id) : null,
      // Flags an A match whose source differs from the dead row's. Expected for
      // rows whose source flipped during a resync (that IS bug B's mechanism),
      // but recorded so those can be audited specifically.
      source_changed: bucket === 'A' && dead?.source && candidates[0].source !== dead.source
        ? `${dead.source}->${candidates[0].source}` : null,
      deleted_title: dead?.title ?? null,
      deleted_source: dead?.source ?? null,
      recovered_from: dead?.from ?? null,
      sess_title: sess.title,
      message_count: sess.message_count ?? 0,
      cwd: sess.cwd,
      started_at: sess.started_at,
      archived: sess.archived,
      throwaway_reason: tw,
    });
  }
  return rows;
}

// ── Holding tasks (bucket B) ───────────────────────────────────────────────

/**
 * Name for a holding task. Preference order: an explicit override (so a human
 * can apply naming/language rules per item), then the recovered original title,
 * then the richest session's own title. Never a hardcoded per-install string.
 */
function holdingTitleFor(deadId, rowsForTask, genericTitles) {
  if (overrides.holdingTitles[deadId]) return overrides.holdingTitles[deadId];
  const withTitle = rowsForTask.find(
    (r) => r.deleted_title && !genericTitles.has(normTitle(r.deleted_title)),
  );
  if (withTitle) return withTitle.deleted_title.slice(0, 200);
  const richest = [...rowsForTask].sort((a, b) => b.message_count - a.message_count)[0];
  const raw = (richest?.sess_title ?? '').split('\n')[0].trim();
  return raw ? raw.slice(0, 200) : `Recovered sessions (${deadId})`;
}

// ── Main ───────────────────────────────────────────────────────────────────

for (const f of [SESSIONS_DB, TASKS_DB]) {
  if (!fs.existsSync(f)) { console.error(`missing db: ${f}`); process.exit(1); }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

console.log('=== orphaned session→task link repair ===');
console.log('mode:     ', VERIFY_ONLY ? 'VERIFY' : APPLY ? `APPLY${CREATE_HOLDING ? ' +holding' : ''}` : 'DRY-RUN');
console.log('sessions: ', SESSIONS_DB);
console.log('tasks:    ', TASKS_DB);
if (overrides.skipSessions.length || Object.keys(overrides.holdingTitles).length) {
  console.log('overrides:', OVERRIDES_FILE,
    `(skip ${overrides.skipSessions.length}, titles ${Object.keys(overrides.holdingTitles).length})`);
}

/** Count remote ids owned by more than one task row — bug B, measured live. */
function duplicateRemoteIdGroups(taskRows) {
  const groups = new Map();
  for (const t of taskRows) {
    const rid = remoteIdOf(t.ext);
    if (!rid) continue;
    if (!groups.has(rid)) groups.set(rid, []);
    groups.get(rid).push(t.id);
  }
  return [...groups.values()].filter((v) => v.length > 1);
}

// The read phase is strictly read-only, so it is safe against a live server.
let ro = { s: openRo(SESSIONS_DB), t: openRo(TASKS_DB) };
const liveTaskIds = new Set(ro.t.prepare('SELECT id FROM tasks').all().map((r) => r.id));
const orphans = ro.s.prepare(`
  SELECT claude_session_id, task_id, title, project, cwd, host, message_count,
         started_at, last_active_at, archived, process_status
  FROM sessions
  WHERE task_id IS NOT NULL AND task_id != ''
  ORDER BY started_at
`).all().filter((r) => !liveTaskIds.has(r.task_id));

const deadTaskIds = new Set(orphans.map((o) => o.task_id));
console.log(`\norphans: ${orphans.length} sessions across ${deadTaskIds.size} dead task ids`);

if (VERIFY_ONLY) {
  const dups = duplicateRemoteIdGroups(ro.t.prepare('SELECT id, ext FROM tasks').all());
  console.log(`duplicate remote ids: ${dups.length} groups, ${dups.reduce((n, v) => n + v.length, 0)} task rows (bug B)`);
  ro.s.close(); ro.t.close();
  process.exit(orphans.length > 0 ? 1 : 0);
}

console.log('recovering deleted task records…');
const recovered = recoverDeletedTasks([...deadTaskIds]);
console.log(`  recovered ${recovered.size} of ${deadTaskIds.size} dead task records`);

const liveTasks = ro.t.prepare('SELECT id, title, project, source, phase, ext FROM tasks').all();
const genericTitles = deriveGenericTitles(liveTasks, recovered);
console.log(`  derived ${genericTitles.size} non-identifying titles (excluded from title matching)`);

const skipSessions = overrides.skipSessions;
const rows = classify({ orphans, liveTasks, recovered, genericTitles, skipSessions });
const skipped = orphans.length - rows.length;
if (skipped > 0) console.log(`  skipped ${skipped} session(s) listed in overrides.skipSessions`);
ro.s.close(); ro.t.close();

const bucketRows = (b) => rows.filter((r) => r.bucket === b);

// Guard: never repoint a session onto a task that is itself one of bug B's
// duplicate rows — that target may be cleaned up later, re-orphaning the very
// session we just fixed. Measured 0 on 2026-08-20; enforced so it stays 0.
{
  const dupIds = new Set(duplicateRemoteIdGroups(liveTasks).flat());
  const onDup = bucketRows('A').filter((r) => dupIds.has(r.new_task_id));
  if (onDup.length) {
    console.log(`\n!! ${onDup.length} bucket-A target(s) are themselves duplicate rows — demoting to A? for manual review:`);
    for (const r of onDup) {
      console.log(`   ${r.sid.slice(0, 8)} -> ${r.new_task_id}`);
      r.bucket = 'A?';
      r.ambiguous_candidates = [r.new_task_id];
      r.new_task_id = null;
      r.how = `${r.how} (target is a duplicate row)`;
    }
  }
}

const counts = rows.reduce((a, r) => { a[r.bucket] = (a[r.bucket] ?? 0) + 1; return a; }, {});
console.log('\n--- classification ---');
console.log(`A  repoint to live twin : ${counts.A ?? 0}  -> ${new Set(bucketRows('A').map((r) => r.new_task_id)).size} distinct tasks`);
console.log(`A? ambiguous (skipped)  : ${counts['A?'] ?? 0}`);
console.log(`B  real content, no twin: ${counts.B ?? 0}  across ${new Set(bucketRows('B').map((r) => r.old_task_id)).size} dead tasks`);
console.log(`C  throwaway (archive)  : ${counts.C ?? 0}`);
console.log(`D  thin (clear pointer) : ${counts.D ?? 0}`);

const byHow = bucketRows('A').reduce((a, r) => { a[r.how] = (a[r.how] ?? 0) + 1; return a; }, {});
console.log(`   A match methods: ${JSON.stringify(byHow)}`);
const srcChanged = bucketRows('A').filter((r) => r.source_changed);
if (srcChanged.length) console.log(`   A rows whose source changed: ${srcChanged.length} (flagged in manifest)`);

console.log('\n--- bucket A sample (10) ---');
for (const r of bucketRows('A').slice(0, 10)) {
  console.log(`  ${r.sid.slice(0, 8)} mc=${String(r.message_count).padStart(4)} ${r.old_task_id} -> ${r.new_task_id} [${r.how}]`);
  console.log(`      dead: ${(r.deleted_title ?? '-').slice(0, 76)}`);
  console.log(`      live: ${(r.new_task_title ?? '-').slice(0, 76)}`);
}

const holdingGroups = new Map();
for (const r of bucketRows('B')) {
  if (!holdingGroups.has(r.old_task_id)) holdingGroups.set(r.old_task_id, []);
  holdingGroups.get(r.old_task_id).push(r);
}
if (holdingGroups.size) {
  console.log(`\n--- bucket B: ${holdingGroups.size} holding task(s) ${CREATE_HOLDING ? 'to create' : '(pass --create-holding to create)'} ---`);
  for (const [deadId, rs] of holdingGroups) {
    const msgs = rs.reduce((n, r) => n + r.message_count, 0);
    console.log(`  ${deadId}  ${rs.length} sess, ${msgs} msgs :: ${holdingTitleFor(deadId, rs, genericTitles).slice(0, 74)}`);
  }
}

// ── Manifest (written on dry runs too — it IS the review artifact) ──────────

const manifestPath = path.join(DATA_DIR, `orphan-repair-manifest-${stamp}.jsonl`);

function actionFor(r) {
  switch (r.bucket) {
    case 'A': return 'repoint task_id';
    case 'A?': return 'skipped (ambiguous)';
    case 'B': return CREATE_HOLDING ? 'repoint to new holding task' : 'skipped (no --create-holding)';
    case 'C': return 'archive + clear task_id';
    case 'D': return 'clear task_id';
    default: return 'none';
  }
}

function writeManifest(applied, backups, holdingCreated) {
  const lines = [JSON.stringify({
    _summary: true,
    at: new Date().toISOString(),
    mode: APPLY ? (CREATE_HOLDING ? 'apply+holding' : 'apply') : 'dry-run',
    orphansFound: orphans.length,
    deadTaskIds: deadTaskIds.size,
    deadTaskRecordsRecovered: recovered.size,
    counts,
    backups,
    holdingCreated,
    skippedByOverride: skipSessions,
  })];
  for (const r of rows) lines.push(JSON.stringify({ ...r, action: actionFor(r), applied: !!applied }));
  fs.writeFileSync(manifestPath, lines.join('\n') + '\n');
  console.log(`\nmanifest: ${manifestPath}`);
}

if (!APPLY) {
  writeManifest(false, null, null);
  console.log('\nDry-run only. Re-run with --apply to write (both DBs are backed up first).');
  process.exit(0);
}

// ── Write phase ────────────────────────────────────────────────────────────

const backups = {
  sessions: `${SESSIONS_DB}.orphan-repair-${stamp}.backup`,
  tasks: `${TASKS_DB}.orphan-repair-${stamp}.backup`,
};
fs.copyFileSync(SESSIONS_DB, backups.sessions);
fs.copyFileSync(TASKS_DB, backups.tasks);
console.log(`\nbackups:\n  ${backups.sessions}\n  ${backups.tasks}`);

const changed = { A: 0, B: 0, C: 0, D: 0 };
const holdingCreated = [];

// Holding tasks first: bucket B's repoint needs their ids to exist.
if (CREATE_HOLDING && holdingGroups.size) {
  const tdb = new Database(TASKS_DB);
  const before = tdb.prepare('SELECT count(*) AS n FROM tasks').get().n;
  const cols = ['id', 'title', 'project', 'status', 'phase', 'priority', 'source',
    'created_at', 'updated_at', 'completed_at', 'session_ids', 'note', 'summary', 'description'];
  const insert = tdb.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  );
  const now = new Date().toISOString();
  tdb.transaction(() => {
    for (const [deadId, rs] of holdingGroups) {
      const id = generateId();
      insert.run({
        id,
        title: holdingTitleFor(deadId, rs, genericTitles),
        project: '',                 // Inbox
        status: 'done',
        phase: 'COMPLETE',
        priority: 'none',
        // MUST stay 'local': a synced source would make the sync plugin try to
        // push this reconstructed row upstream as a brand-new remote item.
        source: 'local',
        created_at: rs[0].started_at ?? now,
        updated_at: now,
        completed_at: now,
        session_ids: '[]',           // rebuilt at read time from sessions.task_id
        note: `Holding task created by scripts/repair-orphan-session-links.mjs on ${now}.\n`
          + `Original task ${deadId} was deleted; ${rs.length} session(s) with real content pointed at it.\n`
          + `Sessions: ${rs.map((r) => r.sid).join(', ')}`,
        summary: '',
        description: '',
      });
      holdingCreated.push({ deadTaskId: deadId, newTaskId: id, sessions: rs.map((r) => r.sid) });
      for (const r of rs) r.new_task_id = id;
    }
  })();
  const after = tdb.prepare('SELECT count(*) AS n FROM tasks').get().n;
  tdb.close();
  console.log(`\nholding tasks created: ${holdingCreated.length} (tasks ${before} -> ${after})`);
  if (after !== before + holdingCreated.length) {
    console.error('!! task count moved unexpectedly — another writer is active. Restore from the backup above.');
    process.exit(1);
  }
}

const sdb = new Database(SESSIONS_DB);
// `AND task_id = ?` makes every statement a no-op if the row already moved:
// idempotent on re-run, and it never clobbers a concurrent change.
const repoint = sdb.prepare('UPDATE sessions SET task_id = ? WHERE claude_session_id = ? AND task_id = ?');
const clear = sdb.prepare('UPDATE sessions SET task_id = NULL WHERE claude_session_id = ? AND task_id = ?');
const archive = sdb.prepare(
  `UPDATE sessions SET archived = 1, archive_reason = ?, task_id = NULL
   WHERE claude_session_id = ? AND task_id = ?`,
);

sdb.transaction(() => {
  for (const r of rows) {
    if (r.bucket === 'A' && r.new_task_id) {
      changed.A += repoint.run(r.new_task_id, r.sid, r.old_task_id).changes;
    } else if (r.bucket === 'B' && CREATE_HOLDING && r.new_task_id) {
      changed.B += repoint.run(r.new_task_id, r.sid, r.old_task_id).changes;
    } else if (r.bucket === 'C') {
      changed.C += archive.run(
        `orphan-repair: ${r.throwaway_reason ?? 'throwaway test session'}`, r.sid, r.old_task_id,
      ).changes;
    } else if (r.bucket === 'D') {
      changed.D += clear.run(r.sid, r.old_task_id).changes;
    }
  }
})();
sdb.close();

console.log(`\napplied: A=${changed.A} B=${changed.B} C=${changed.C} D=${changed.D}`);

// ── Post-write verification ────────────────────────────────────────────────

ro = { s: openRo(SESSIONS_DB), t: openRo(TASKS_DB) };
const liveAfter = new Set(ro.t.prepare('SELECT id FROM tasks').all().map((r) => r.id));
const stillOrphan = ro.s.prepare(
  `SELECT claude_session_id, task_id FROM sessions WHERE task_id IS NOT NULL AND task_id != ''`,
).all().filter((r) => !liveAfter.has(r.task_id));
ro.s.close(); ro.t.close();

const expectRemaining = rows.filter(
  (r) => r.bucket === 'A?' || (r.bucket === 'B' && !CREATE_HOLDING),
).length + skipped;
console.log(`\nverify: ${stillOrphan.length} orphan(s) remain (expected ${expectRemaining}: ambiguous${CREATE_HOLDING ? '' : ' + bucket B'}${skipped ? ' + overridden' : ''})`);

const stillOrphanSids = new Set(stillOrphan.map((o) => o.claude_session_id));
const leakedA = bucketRows('A').filter((r) => stillOrphanSids.has(r.sid));
if (leakedA.length) {
  console.error(`!! ${leakedA.length} bucket-A session(s) are still orphaned — investigate before trusting this run.`);
}

writeManifest(true, backups, holdingCreated);
process.exit(leakedA.length ? 1 : 0);
