#!/usr/bin/env npx tsx
/**
 * One-time repair: re-point sessions whose task_id references a task that no
 * longer exists.
 *
 * How tasks vanished (2026-08 investigation): sync re-created tasks under NEW
 * local ids for the same remote item, then dedup cleanups deleted the ORIGINAL
 * rows — leaving sessions.task_id pointing at ids that are gone (254 dangling
 * rows found). The remote id is the stable join key: read the dead task's
 * remote id from a pre-cleanup backup DB, find today's task holding that same
 * remote id, re-point the session.
 *
 * Only touches sessions.task_id. Never deletes anything. Unresolvable rows are
 * reported, not guessed at.
 *
 * Usage:
 *   npx tsx scripts/repair-orphaned-session-links.ts             # dry run (default)
 *   npx tsx scripts/repair-orphaned-session-links.ts --live      # apply
 *   npx tsx scripts/repair-orphaned-session-links.ts --live --backup <path-to-old-tasks.sqlite>
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const WALNUT_HOME = process.env.OPEN_WALNUT_HOME ?? path.join(process.env.HOME!, '.open-walnut');
const SESSIONS_DB = path.join(WALNUT_HOME, 'sessions.sqlite');
const TASKS_DB = path.join(WALNUT_HOME, 'tasks', 'tasks.sqlite');

const isTestEnv = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
if (isTestEnv && WALNUT_HOME === path.join(process.env.HOME!, '.open-walnut')) {
  console.error('SAFETY: refusing to run against production ~/.open-walnut/ in a test environment');
  process.exit(1);
}

const live = process.argv.includes('--live');
const backupFlagIdx = process.argv.indexOf('--backup');
const backupArg = backupFlagIdx >= 0 ? process.argv[backupFlagIdx + 1] : undefined;

/** Default backup candidates, newest-first — the first that exists wins. */
const BACKUP_CANDIDATES = [
  path.join(WALNUT_HOME, 'tasks', 'tasks.sqlite.pre-cleanup-0806.backup'),
  path.join(WALNUT_HOME, 'tasks', 'tasks.pre-cleanup.sqlite'),
  path.join(WALNUT_HOME, 'tasks', 'tasks.sqlite.pre-repair-0805.backup'),
];

/**
 * Remote-id candidates for a task's ext, by convention: plugins store their
 * item id under ext[source].id (jira uses issue_key). Generic on purpose —
 * external plugins ride the same convention without being named here.
 */
function remoteIdsOf(source: string | null, extJson: string | null): string[] {
  if (!source || !extJson || source === 'local') return [];
  try {
    const ext = JSON.parse(extJson) as Record<string, any>;
    const node = ext[source];
    if (!node || typeof node !== 'object') return [];
    return [node.id, node.issue_key, node.key]
      .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function main() {
  console.log(`\n=== Orphaned session-link repair ${live ? '(LIVE)' : '(DRY RUN — pass --live to apply)'} ===\n`);

  const backupPaths = (backupArg ? [backupArg] : BACKUP_CANDIDATES).filter((p) => fs.existsSync(p));
  if (backupPaths.length === 0) {
    console.error('No backup DB found. Pass --backup <path-to-old-tasks.sqlite>.');
    process.exit(1);
  }
  console.log(`Backup DBs (newest first): ${backupPaths.join(', ')}`);

  const sessions = new Database(SESSIONS_DB, { readonly: !live });
  const tasksDb = new Database(TASKS_DB, { readonly: true });
  const backups = backupPaths.map((p) => new Database(p, { readonly: true }));

  // 1. Dangling sessions: task_id set, but no such task today.
  const taskExists = tasksDb.prepare('SELECT 1 FROM tasks WHERE id = ?');
  const dangling = (sessions.prepare(
    `SELECT claude_session_id, task_id, title FROM sessions
      WHERE task_id IS NOT NULL AND task_id != ''`,
  ).all() as Array<{ claude_session_id: string; task_id: string; title: string | null }>)
    .filter((s) => !taskExists.get(s.task_id));

  console.log(`Dangling session links: ${dangling.length}\n`);
  if (dangling.length === 0) return;

  // 2. For each dead task id: backup row → remote id → today's task with that
  //    remote id. Newest backup that still has the row wins.
  const backupStmts = backups.map((b) => b.prepare('SELECT id, source, ext, title FROM tasks WHERE id = ?'));
  const backupTask = { get: (taskId: string) => {
    for (const stmt of backupStmts) {
      const row = stmt.get(taskId);
      if (row) return row;
    }
    return undefined;
  } };
  // Per-source prepared statement, built lazily. The source name is inlined
  // into the json path (single quotes escaped); the remote id itself is bound.
  const findStmts = new Map<string, ReturnType<typeof tasksDb.prepare>>();
  const findByRemoteId = (source: string, rid: string): { id: string; title: string } | undefined => {
    let stmt = findStmts.get(source);
    if (!stmt) {
      const src = source.replace(/'/g, "''").replace(/"/g, '');
      stmt = tasksDb.prepare(
        `SELECT id, title FROM tasks
          WHERE source = '${src}' AND (
            json_extract(ext, '$."${src}".id') = ?
            OR json_extract(ext, '$."${src}".issue_key') = ?
            OR json_extract(ext, '$."${src}".key') = ?
          ) LIMIT 1`,
      );
      findStmts.set(source, stmt);
    }
    return stmt.get(rid, rid, rid) as { id: string; title: string } | undefined;
  };

  let repaired = 0;
  const unresolved: Array<{ sid: string; taskId: string; reason: string; title: string | null }> = [];
  const updateSession = live
    ? sessions.prepare('UPDATE sessions SET task_id = ? WHERE claude_session_id = ?')
    : null;

  for (const s of dangling) {
    const old = backupTask.get(s.task_id) as { id: string; source: string | null; ext: string | null; title: string | null } | undefined;
    if (!old) {
      unresolved.push({ sid: s.claude_session_id, taskId: s.task_id, reason: 'not in backup', title: s.title });
      continue;
    }
    const rids = remoteIdsOf(old.source, old.ext);
    if (rids.length === 0) {
      unresolved.push({ sid: s.claude_session_id, taskId: s.task_id, reason: `no remote id (source=${old.source ?? 'local'})`, title: s.title });
      continue;
    }
    let current: { id: string; title: string } | undefined;
    for (const rid of rids) {
      current = findByRemoteId(old.source!, rid);
      if (current) break;
    }
    if (!current) {
      unresolved.push({ sid: s.claude_session_id, taskId: s.task_id, reason: 'remote id not held by any current task', title: s.title });
      continue;
    }
    console.log(`REPAIR ${s.claude_session_id}`);
    console.log(`   session "${(s.title ?? '').slice(0, 60)}"`);
    console.log(`   ${s.task_id} (deleted) → ${current.id} "${current.title.slice(0, 60)}"`);
    if (updateSession) updateSession.run(current.id, s.claude_session_id);
    repaired++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Repaired: ${repaired}${live ? '' : ' (dry run)'}`);
  console.log(`Unresolved: ${unresolved.length}`);
  for (const u of unresolved) {
    console.log(`  ${u.sid}  task=${u.taskId}  [${u.reason}]  "${(u.title ?? '').slice(0, 50)}"`);
  }
  if (!live) console.log('\nDry run only — nothing was changed.');
}

main();
