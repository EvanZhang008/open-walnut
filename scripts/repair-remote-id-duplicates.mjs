#!/usr/bin/env node
/**
 * Find (and optionally repair) tasks that share ONE remote id with another task.
 *
 * "One remote item maps to at most one local task" is a framework invariant
 * (src/core/task-remote-links.ts). It was enforced by a racy read for three
 * rounds of the same bug, so it is now a partial UNIQUE index per sync plugin
 * (src/core/task-db.ts ensureExtIndexes, ExtIndexPath.unique). That index cannot
 * be created while violations exist, and on failure the server falls back to a
 * plain index and reports the gap on GET /api/config. This script is both the
 * report and the repair that closes the gap, and afterwards the standing health
 * check (`--report` exits non-zero when anything is left).
 *
 * WHY THE REPAIR GOES THROUGH THE SERVER, NOT SQL:
 *   A duplicate holds the SURVIVOR's remote id. A plain DELETE would (a) write a
 *   'deleted' tombstone whose PK (remote_source, remote_id) OVERWRITES the
 *   survivor's 'owned' row, so every future pull treats the survivor as deleted,
 *   and (b) fire the plugin's deleteTask hook, which deletes the survivor's real
 *   remote twin at the provider. So repair uses POST /api/tasks/:id/merge, which
 *   routes to mergeTaskInto(): it unions session_ids, fills empty session slots,
 *   re-homes children, re-points sessions.task_id, and deliberately SKIPS
 *   tombstoning any id the survivor still holds. It also never touches the
 *   provider. Hand-editing sqlite while the server is running would additionally
 *   race its cached store.
 *
 * Nothing provider-specific is hardcoded: the (source, json path) pairs are read
 * out of the ext indexes the loaded plugins declared, so a new sync plugin is
 * covered the moment it registers one.
 *
 * Usage:
 *   node scripts/repair-remote-id-duplicates.mjs                 # report only (default)
 *   node scripts/repair-remote-id-duplicates.mjs --apply         # merge duplicates
 *   node scripts/repair-remote-id-duplicates.mjs --apply --source <id>
 *   node scripts/repair-remote-id-duplicates.mjs --enforce       # upgrade indexes to UNIQUE
 *   node scripts/repair-remote-id-duplicates.mjs --json          # machine-readable report
 *   WALNUT_URL=http://127.0.0.1:3456 ... (default)
 *
 * WHY --enforce EXISTS AT ALL:
 *   The server upgrades an ext index to UNIQUE only for a path a LOADED plugin
 *   declared (ensureExtIndexes runs off registerExtIndex). A plugin that fails to
 *   activate — bad config, missing credential, an external plugin dropped from
 *   the install — leaves its rows in the DB with an unmanaged, non-unique index,
 *   which is how one provider here accumulated 32 duplicate groups unnoticed. The
 *   invariant belongs to the DATA, not to whether today's process could load the
 *   code that writes it, so --enforce upgrades any discovered identity index.
 *   It is a separate explicit flag rather than boot behavior because for an
 *   unloaded plugin the identity path can only be inferred from the index name,
 *   and guessing is not something server startup should do unsupervised.
 *
 * Survivor rule (deterministic, printed for every group):
 *   1. the row with session links (session_ids or any session slot) wins — those
 *      are the links a naive dedup destroys;
 *   2. else the row with content (note/summary/description) wins;
 *   3. else the EARLIER created_at wins: a fork is by construction the younger
 *      row, and the original owns the local task id that notes, memory and
 *      commit messages already reference;
 *   4. tie-break on the more recently updated row.
 *
 * `updated_at` deliberately does NOT come before created_at. A fork is minted by
 * the same sync tick that touches its original and frequently carries the LATER
 * stamp (measured: the 2026-09-01 duplicates each had an updated_at ~1s after
 * their original's), so ranking on it keeps the fork and deletes the real task.
 * mergeTaskInto also folds the earliest created_at onto the survivor and unions
 * session_ids, so choosing the original loses nothing.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const DB_PATH = process.env.WALNUT_TASKS_DB
  ?? path.join(os.homedir(), '.open-walnut', 'tasks', 'tasks.sqlite');
const BASE_URL = process.env.WALNUT_URL ?? 'http://127.0.0.1:3456';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ENFORCE = args.includes('--enforce');
const AS_JSON = args.includes('--json');
const SOURCE_FILTER = (() => {
  const i = args.indexOf('--source');
  return i >= 0 ? args[i + 1] : null;
})();

/**
 * (source, jsonPath) pairs, derived from the ext indexes in the DB rather than a
 * hardcoded provider list. Index name is `idx_tasks_ext_<source>_<key>` and the
 * SQL carries both the json_extract path and the `WHERE source = '<source>'`
 * predicate, so the exact source string comes from the predicate (the name is
 * sanitized and lossy).
 */
function discoverExtIdPaths(db) {
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_tasks_ext_%' AND sql IS NOT NULL",
  ).all();
  const out = new Map(); // `${source}\0${jsonPath}` -> {source, jsonPath, indexName, unique}
  for (const { name, sql } of rows) {
    const jsonPath = /json_extract\(ext,\s*'([^']+)'\)/.exec(sql)?.[1];
    const source = /WHERE\s+source\s*=\s*'((?:[^']|'')+)'/.exec(sql)?.[1]?.replace(/''/g, "'");
    if (!jsonPath || !source) continue;
    // Only the PRIMARY identity path can be meaningfully deduped; a secondary
    // path (short ids etc.) may legitimately repeat.
    if (!/\.id"?$/.test(jsonPath) && !/issue_key"?$/.test(jsonPath)) continue;
    out.set(`${source}\0${jsonPath}`, {
      source, jsonPath, indexName: name, unique: /CREATE UNIQUE INDEX/i.test(sql),
    });
  }
  return [...out.values()];
}

function findGroups(db, source, jsonPath) {
  const rows = db.prepare(
    `SELECT json_extract(ext, ?) AS remote_id, group_concat(id) AS ids, COUNT(*) AS n
       FROM tasks
      WHERE source = ? AND json_extract(ext, ?) IS NOT NULL
      GROUP BY remote_id HAVING n > 1 ORDER BY remote_id`,
  ).all(jsonPath, source, jsonPath);
  return rows.map((r) => ({ remoteId: r.remote_id, taskIds: (r.ids ?? '').split(',') }));
}

/**
 * Rows whose stored container id disagrees with the container the item id says it
 * belongs to — the OTHER half of the 2026-09-01 damage. Two tasks carried an id
 * from the old list beside a list_id already rewritten to the new one.
 *
 * This class is SILENT, which is why it needs a report at all: the provider
 * accepts an update addressed to the wrong container as long as the item id is
 * real, so those rows push successfully forever. What fails is the delete half of
 * their next container move, which leaves the real remote item behind for the
 * next pull to import as a duplicate.
 *
 * No network calls: hierarchical remote ids embed their container's distinctive
 * middle segment verbatim, so a mismatch is detectable locally. Take the
 * container id, drop its padding tail, keep what follows the last marker group,
 * and look for that inside the item id.
 *
 * SELF-LIMITING because that shape is not universal: if under 90% of a source's
 * rows parse, the check reports "not applicable" for that source rather than
 * inventing findings from ids it does not understand. Measured on the live DB:
 * 1970 rows, 1970 parsed, 2 mismatches, both of them the known-bad pair.
 */
function containerMismatches(db, source, jsonPath) {
  const listPath = `$."${source}".list_id`;
  const rows = db.prepare(
    `SELECT id, project, json_extract(ext, ?) AS rid, json_extract(ext, ?) AS lid
       FROM tasks
      WHERE source = ? AND json_extract(ext, ?) IS NOT NULL AND json_extract(ext, ?) IS NOT NULL`,
  ).all(jsonPath, listPath, source, jsonPath, listPath);
  if (rows.length === 0) return { applicable: false, checked: 0, rows: [] };

  const segmentOf = (containerId) => {
    const trimmed = String(containerId).replace(/A+=*$/, '');
    const m = trimmed.match(/GAA.(.+)$/);
    return m && m[1].length >= 4 ? m[1] : null;
  };

  const bad = [];
  let parsed = 0;
  for (const r of rows) {
    const seg = segmentOf(r.lid);
    if (!seg) continue;
    parsed++;
    if (!String(r.rid).includes(seg)) bad.push({ id: r.id, project: r.project, segment: seg });
  }
  if (parsed / rows.length < 0.9) return { applicable: false, checked: rows.length, rows: [] };
  return { applicable: true, checked: parsed, rows: bad };
}

function loadTask(db, id) {
  const r = db.prepare(
    `SELECT id, title, project, status, phase, source, created_at, updated_at, _synced_at,
            session_ids, note, summary, description, ext, payload
       FROM tasks WHERE id = ?`,
  ).get(id);
  if (!r) return null;
  let sessionIds = [];
  try { sessionIds = JSON.parse(r.session_ids ?? '[]') ?? []; } catch { /* malformed */ }
  let slots = 0;
  try {
    const p = JSON.parse(r.payload ?? '{}') ?? {};
    for (const k of ['session_id', 'plan_session_id', 'exec_session_id']) if (p[k]) slots++;
  } catch { /* malformed */ }
  const contentLen = (r.note?.length ?? 0) + (r.summary?.length ?? 0) + (r.description?.length ?? 0);
  return {
    ...r,
    sessionLinkCount: (Array.isArray(sessionIds) ? sessionIds.length : 0) + slots,
    contentLen,
  };
}

/** Deterministic survivor pick — see the header comment for the rule. */
function pickSurvivor(tasks) {
  const sorted = [...tasks].sort((a, b) => {
    if (b.sessionLinkCount !== a.sessionLinkCount) return b.sessionLinkCount - a.sessionLinkCount;
    if (b.contentLen !== a.contentLen) return b.contentLen - a.contentLen;
    // Earlier created_at first: keep the ORIGINAL, never the fork.
    const ac = a.created_at ?? '', bc = b.created_at ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    const au = a.updated_at ?? '', bu = b.updated_at ?? '';
    return bu < au ? -1 : bu > au ? 1 : 0;
  });
  return { survivor: sorted[0], victims: sorted.slice(1) };
}

async function mergeViaServer(survivorId, victimIds) {
  const res = await fetch(`${BASE_URL}/api/tasks/${survivorId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ victim_ids: victimIds }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`merge ${survivorId} <- ${victimIds.join(',')} failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function serverIsUp() {
  try {
    const res = await fetch(`${BASE_URL}/api/config`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: !false });
  const specs = discoverExtIdPaths(db)
    .filter((s) => !SOURCE_FILTER || s.source === SOURCE_FILTER);

  const report = [];
  for (const spec of specs) {
    const groups = findGroups(db, spec.source, spec.jsonPath);
    // Structurally incomplete identity: an id with no list/container recorded.
    // Provider-agnostic (the key name is not assumed to be meaningful beyond
    // "something else lives next to the id"), reported but never auto-fixed —
    // resolving it needs a provider call to learn where the item actually lives.
    const idOnly = db.prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE source = ? AND json_extract(ext, ?) IS NOT NULL
          AND json_extract(ext, '$."' || ? || '".list_id') IS NULL`,
    ).get(spec.source, spec.jsonPath, spec.source)?.n ?? 0;
    report.push({
      ...spec,
      groups,
      incompleteIdentityRows: idOnly,
      containerMismatch: containerMismatches(db, spec.source, spec.jsonPath),
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ dbPath: DB_PATH, specs: report }, null, 2));
  } else {
    console.log(`DB: ${DB_PATH}`);
    for (const r of report) {
      const flag = r.unique ? 'UNIQUE enforced' : 'NOT unique (gap)';
      console.log(`\n── source=${r.source}  path=${r.jsonPath}  [${flag}]`);
      console.log(`   duplicate groups: ${r.groups.length}`);
      if (r.incompleteIdentityRows) {
        console.log(`   rows with an id but no list recorded: ${r.incompleteIdentityRows} (report only)`);
      }
      const cm = r.containerMismatch;
      if (cm?.applicable) {
        console.log(
          `   stored list disagrees with the id's own list: ${cm.rows.length} of ${cm.checked} checked`
          + (cm.rows.length ? ' — re-anchored on the next push of each row' : ''),
        );
        for (const m of cm.rows) console.log(`       ${m.id}  proj=${m.project ?? ''}`);
      }
      for (const g of r.groups) {
        const tasks = g.taskIds.map((id) => loadTask(db, id)).filter(Boolean);
        const { survivor, victims } = pickSurvivor(tasks);
        console.log(`   • ${g.remoteId.slice(-16)}`);
        for (const t of tasks) {
          const mark = t.id === survivor.id ? 'KEEP  ' : 'merge→';
          console.log(
            `       ${mark} ${t.id}  links=${t.sessionLinkCount} content=${t.contentLen}` +
            `  proj=${t.project ?? ''}  upd=${t.updated_at ?? ''}  ${String(t.title).slice(0, 44)}`,
          );
        }
        void victims;
      }
    }
  }

  const totalGroups = report.reduce((n, r) => n + r.groups.length, 0);
  db.close();

  if (ENFORCE) {
    if (totalGroups > 0) {
      console.error(`\nRefusing to enforce: ${totalGroups} duplicate group(s) still exist.`);
      console.error('Run --apply first; a UNIQUE index cannot be created over a violation.');
      process.exit(2);
    }
    // Recreating an index touches no row, so it is safe beside a running server
    // (unlike editing task rows, which would race its cached store). SQLite
    // rebuilds the index inside its own write transaction.
    const wdb = new Database(DB_PATH);
    let upgraded = 0;
    for (const r of report) {
      if (r.unique) { console.log(`already UNIQUE: ${r.indexName}`); continue; }
      wdb.exec(`DROP INDEX IF EXISTS "${r.indexName}";`);
      wdb.exec(
        `CREATE UNIQUE INDEX "${r.indexName}" ON tasks(json_extract(ext, '${r.jsonPath.replace(/'/g, "''")}'))` +
        ` WHERE source = '${r.source.replace(/'/g, "''")}';`,
      );
      upgraded++;
      console.log(`UPGRADED to UNIQUE: ${r.indexName}  (source=${r.source})`);
    }
    wdb.close();
    console.log(`\nupgraded=${upgraded}`);
    process.exit(0);
  }

  if (!APPLY) {
    if (!AS_JSON) {
      console.log(
        totalGroups === 0
          ? '\nOK: no task shares a remote id with another task.'
          : `\n${totalGroups} duplicate group(s) remain. Re-run with --apply to merge them.`,
      );
    }
    process.exit(totalGroups === 0 ? 0 : 1);
  }

  if (totalGroups === 0) { console.log('\nNothing to do.'); process.exit(0); }

  // The merge must go through the running server (its cached store, its locks,
  // its ledger-aware merge path). Refuse rather than corrupt.
  if (!await serverIsUp()) {
    console.error(`\nRefusing to apply: no server answering at ${BASE_URL}/api/config.`);
    console.error('The repair must run through the server write path (see header).');
    process.exit(2);
  }

  const rdb = new Database(DB_PATH, { readonly: true });
  let merged = 0, failed = 0;
  for (const r of report) {
    for (const g of r.groups) {
      const tasks = g.taskIds.map((id) => loadTask(rdb, id)).filter(Boolean);
      if (tasks.length < 2) continue;
      const { survivor, victims } = pickSurvivor(tasks);
      try {
        const out = await mergeViaServer(survivor.id, victims.map((v) => v.id));
        merged += victims.length;
        console.log(
          `merged ${victims.map((v) => v.id).join(',')} → ${survivor.id}` +
          `  (sessions_relinked=${out.sessions_relinked ?? 0})`,
        );
      } catch (err) {
        failed++;
        console.error(`FAILED ${survivor.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  rdb.close();

  console.log(`\nmerged=${merged} failed=${failed}`);
  console.log('Re-run without --apply to verify, then restart the server so the UNIQUE index is created.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
