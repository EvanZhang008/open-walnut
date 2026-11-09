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
  'core/session-tracker.ts#writeSessionRowSqlite': 'assertSessionHistoryWrite',
  'core/session-tracker.ts#batchUpdateSessionRecords': 'assertSessionHistoryWrite',
  'core/session-tracker.ts#renameSessionId': 'assertSessionHistoryWrite',
  'core/session-tracker.ts#retaskSessionRows': 'assertSessionHistoryWrite',
};
const FIXED: Record<string, string> = {
  'core/task-manager.ts#fileTasksLocked': 'Folder, title, tags and pin fields only; no scope or session identity input.',
  'core/session-tracker.ts#scrubInheritedSessionPids': 'Clears pid only; never rewrites a profile or task link.',
  'core/session-tracker.ts#completeTaskSessions': 'Status and pid only; preserves the original policy and task identity.',
  'core/task-manager.ts#applyTaskReplicaRows': 'The authenticated primary projection applied to the follower copy, not a new conversation.',
  'core/session-db.ts#applySessionCopy': 'The authenticated primary projection applied to the follower copy, not a new conversation.',
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
        if (sql && /\b(?:UPDATE\s+(?:tasks|sessions)\s+SET|INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(?:tasks|sessions)\b)/i.test(sql)) {
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
