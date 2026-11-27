import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GUARDED: Record<string, string> = {
  'core/task-manager.ts#writeStore': 'assertTaskHistoryWrite',
  'core/task-manager.ts#updateTaskRaw': 'assertTaskHistoryWrite',
  'core/task-manager.ts#updateTasksBulk': 'assertTaskHistoryWrite',
  'core/task-manager.ts#addTasksBulk': 'assertTaskHistoryWrite',
  // The tracker's every row write (create, update, batch, rename, ACP staging, host channel) goes through it.
  'core/session-tracker.ts#writeSessionRowSqlite': 'assertSessionHistoryWrite',
  'core/session-tracker.ts#retaskSessionRows': 'assertSessionHistoryWrite',
};
const FIXED: Record<string, string> = {
  'core/task-manager.ts#fileTasksLocked': 'Folder, title, tags and pin fields only; no scope or session identity input.',
  'core/session-tracker.ts#scrubInheritedSessionPids': 'Clears pid only; never rewrites a profile or task link.',
  'core/session-tracker.ts#completeTaskSessions': 'Status and pid only; preserves the original policy and task identity.',
  'core/task-manager.ts#applyTaskReplicaRows': 'The authenticated primary projection applied to the follower copy, not a new conversation.',
  'core/session-db.ts#applySessionCopy': 'The authenticated primary projection applied to the follower copy, not a new conversation.',
  'core/session-db.ts#claimStartingRow': 'A host\'s copied row marked this host\'s for a start the leader handed it: the leader\'s projection, not a new conversation.',
  'core/session-db.ts#handOwnRowBack': 'A host\'s copied row written back as the leader has it: the leader\'s projection, not a new conversation.',
  'core/session-db.ts#putSessionRow': 'The store\'s one row writer (session-db.ts): each caller is declared here or guarded (writeSessionRowSqlite).',
  'core/session-db.ts#fillTextRefsBatch': 'Fills a row\'s prompt_text_refs column (the stubs of the texts its payload holds): no payload, task, profile field or identity changes.',
  'core/session-db.ts#refreshPromptStubsIn': 'Brings the prompt stubs (sizes, hashes) and prompt_text_refs back in line with texts the leader switch\'s path rewrite changed: only stub fields change, no task, identity or other profile field.',
  'core/session-db.ts#promptBatch': 'Moves the prompt texts between a row\'s payload and the prompt table (the strip, unsplit): no task, profile field or identity changes.',
  'core/session-db.ts#applyCompanionSessionCopy': 'The authenticated primary projection stored in the separate companion copy.',
  'core/session-db-migration.ts#migrateSessionStore': 'Legacy JSON startup conversion completes before classification; start gates judge preserved rows.',
  'core/task-db-migration.ts#runMigrationIfNeeded': 'Legacy JSON startup conversion preserves historical rows; start gates judge them.',
  'core/task-db.ts#migrateToProjectOnly': 'Startup migration of project and source metadata, not area membership or history.',
  'core/task-db.ts#migrateReadMarkerToUnread': 'Startup read marker conversion only.',
  'core/task-db.ts#migratePhasesToFive': 'Startup phase conversion only.',
  'core/task-db.ts#migrateWaitToTodo': 'Startup phase conversion only.',
  'core/task-db.ts#migrateAgentCompleteToNeedAction': 'Startup phase conversion only.',
  'core/task-db.ts#migrateWaitingRecordsToPhase': 'Startup wait and phase conversion only.',
  'core/task-db.ts#migrateBacklogTierToWait': 'Startup board tier conversion only.',
  'core/task-db.ts#migrateGroupsToFolders': 'Startup folder conversion only.',
  'core/task-db.ts#backfillNullTimestamps': 'Startup timestamp repair only.',
  'core/task-db.ts#normalizeStoredTags': 'Tag normalization only.',
  'core/inbox-migration.ts#migrateInboxProject': 'Startup project conversion only: files projectless rows and folders into the Inbox.',
  'core/leader/switch/session-hosts.ts#moveSessionHosts': 'Changes host, a field the history rule checks (history-write.ts sessionHistoryWriteNeedsCheck), once per switch in the promoted home with no server running on it. It never moves a row with an area profile (session-hosts.ts AREA_PROFILE_SQL, tested against hasAreaProfile), whose host is its area\'s, so no area session leaves its isolated profile; the rows it moves carry no area profile, and their task, profile, engine and origin stay.',
  'core/leader/switch/session-hosts.ts#moveHomeRows': 'The sessions in the data home at a leader switch, in the same promotion transaction as moveSessionHosts and under its rows (MOVES: never an area profile): cwd to the same place in the new home, host cleared to the new leader\'s own daemon or set to the old machine for a row that ends there, archived with why for one that cannot move, and the switch\'s own stamp and folder-moved notice in the payload. Task, profile, engine and origin stay.',
  'hooks/on-compact.ts#updateSessionLastActive': 'Updates last_active_at only.',
  'hooks/session-status-store.ts#markSessionStoppedInSqlite': 'Updates the status projection only.',
  'core/session-db.ts#ensureSessionStatusColumns': 'Adds and backfills the status revision columns only.',
  'hooks/session-status-store.ts#ensureStatusColumns': 'Adds and backfills the status revision columns only.',
  'hooks/shared.ts#updateTaskFromSession': 'Every legacy hook UPDATE rechecks the current row is unscoped in SQL.',
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : /\.[cm]?ts$/.test(entry.name) ? [full] : [];
  });
}
function owner(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current;
  }
  return undefined;
}
function sqlText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  return undefined;
}

describe('every task and session SQL writer has a declared history boundary', () => {
  it('finds new files and functions rather than testing only a fixed list of known writers', () => {
    const found = new Set<string>();
    const undeclared = new Set<string>();
    for (const full of files(path.join(ROOT, 'src'))) {
      const relative = path.relative(path.join(ROOT, 'src'), full).replaceAll(path.sep, '/');
      const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      const walk = (node: ts.Node): void => {
        const sql = sqlText(node);
        // A call of the session store's one row writer is a write of its caller's.
        const put = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'putSessionRow';
        if (put || (sql && /\b(?:UPDATE\s+(?:tasks|sessions)\s+SET|INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(?:tasks|sessions)\b)/i.test(sql))) {
          const fn = owner(node);
          const key = `${relative}#${fn?.name?.text ?? '<unowned>'}`;
          found.add(key);
          if (!GUARDED[key] && !FIXED[key]) undeclared.add(key);
          if (GUARDED[key]) expect(fn?.getText(source), key).toContain(GUARDED[key]);
          if (key === 'hooks/shared.ts#updateTaskFromSession') {
            expect(sql).toContain("json_extract(payload, '$.router_area_id')");
            expect(sql).toContain("json_extract(payload, '$.org_role')");
            expect(sql).toContain('json_valid(payload)');
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
    }
    // Every new writer at once, each needing its policy guard or its fixed non-policy fields.
    expect([...undeclared].sort(), 'declare each writer in GUARDED or FIXED').toEqual([]);
    expect([...found].sort()).toEqual([...Object.keys(GUARDED), ...Object.keys(FIXED)].sort());
  });
});
