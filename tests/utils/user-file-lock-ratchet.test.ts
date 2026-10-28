/**
 * User-file lock ratchet: a lock on a file Walnut does not own never lives next to that file.
 *
 * 2026-10-05: the Files panel locked a user's `Gemfile` with `withFileLock`, whose lock path is
 * `Gemfile.lock`, the user's own lockfile. Once that file was older than 30s the lock code
 * deleted it as a stale lock on every save of the Gemfile. A file a person edits (a file in a
 * repo or a session's working folder, a note in the vault) is locked with `withUserFileLock`
 * (src/utils/user-file-lock.ts), which keeps the lock under WALNUT_HOME/locks.
 *
 * `withFileLock` / `withFileLockSync` stay for Walnut's own stores, whose `<file>.lock` every
 * Walnut process (old builds included) takes. This test scans src/ over the TypeScript AST
 * (comments and strings never count) and allows a call only at the store sites listed below, by
 * file and by the text of the path argument. Any other call fails, and so does taking the
 * function as a value or importing it under another name, since a call through an alias is one
 * the scan cannot see.
 *
 * Adding a site? If the path is a user's file, use `withUserFileLock`. Only a path that is
 * always inside WALNUT_HOME or the daemon dir (and never in the notes vault) belongs here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * `<file>: <path argument>` of every allowed store lock. Allowed by path, not by count: another
 * call on a listed store path is the same store (2026-10-09: the push work adds two more
 * `authFilePath()` locks, which now live in device-store.ts), while a call on any other path text fails.
 */
const STORE_LOCKS = new Set<string>([
  'src/core/boards/board-store.ts: file',                       // WALNUT_HOME/boards/<task>.json
  'src/core/bounded-memory.ts: this.filePath',                  // an agent's memory under WALNUT_HOME
  'src/core/cron/timer.ts: state.deps.storePath',               // the cron jobs store
  'src/core/device-store.ts: authFilePath()',                   // auth.json
  'src/core/feature-nodes/node-store.ts: this.filePath',         // dedicated node store, isolated path in tests
  'src/core/human-inbox/item-ledger.ts: FILE',                  // WALNUT_HOME/human-inbox/item-ledger.json
  'src/core/memory-telemetry.ts: file',                         // telemetry under WALNUT_HOME
  'src/core/notes-identity.ts: NOTES_INDEX_PATH',               // the notes index (not a note)
  'src/core/notes-indexer.ts: NOTES_INDEX_PATH',                // the notes index (not a note)
  'src/core/plugins/boot-sentinel.ts: this.filePath',           // plugin boot record
  'src/core/project-memory.ts: memFile',                        // project memory under WALNUT_HOME
  'src/core/routines/trigger-state.ts: file',                   // trigger state
  'src/core/send-queue.ts: target',                             // send-queue fences
  'src/core/send-relay-index.ts: file',                         // cache/send-queue/relays/<session>.json
  'src/core/session-message-queue.ts: SESSION_QUEUE_FILE',      // the session message queue
  'src/core/sessions/cloud-chat-lane.ts: MARKS_FILE',           // chat lane marks
  'src/core/skill-usage.ts: file',                              // skill usage counts
  "src/core/stt/voice-archive.ts: join(this.dir(id), 'metadata.json')", // WALNUT_HOME/voice-archive/<id>/metadata.json
  'src/core/suggest-accuracy.ts: file',                         // suggestion accuracy stats
  'src/core/task-manager.ts: TASKS_FILE',                       // the task store
  'src/core/triage/runs.ts: file',                              // triage run log
  'src/core/triage/state.ts: file',                             // triage state
  'src/providers/daemon-service-files.ts: ownershipPath',       // daemon dir ownership record
  'src/utils/fs.ts: filePath',                                  // updateJsonFile, Walnut JSON stores only
  'src/utils/user-file-lock.ts: await userFileLockTarget(filePath)', // withUserFileLock itself
]);

/** Files a person's content is written through: each must lock with withUserFileLock. */
const USER_CONTENT_WRITERS: Record<string, number> = {
  'src/web/routes/file-content.ts': 1,  // Files panel save
  'src/web/routes/notes-v2.ts': 1,      // notes editor save
  'src/web/routes/notes.ts': 1,         // global notes save
  'src/web/routes/api-v1.ts': 2,        // phone / agent note PUT and create
  'src/core/notes-identity.ts': 2,      // id stamp written into a note
  'src/core/notes-indexer.ts': 1,       // id written back into a note
  'src/utils/file-ops.ts': 2,           // agent edit + checked write
};

const LOCK_NAMES = new Set(['withFileLock', 'withFileLockSync']);

export interface LockSites {
  /** `<path argument>` of every call of a store lock. */
  calls: string[];
  /** A store lock taken as a value, or imported under another name. */
  indirect: string[];
  /** Calls of withUserFileLock. */
  userCalls: number;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

export function findLockSites(fileName: string, text: string): LockSites {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: LockSites = { calls: [], indirect: [], userCalls: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (LOCK_NAMES.has(imported) && node.name.text !== imported) {
        out.indirect.push(`import ${imported} as ${node.name.text}`);
      }
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && LOCK_NAMES.has(name)) {
        out.calls.push(node.arguments[0] ? node.arguments[0].getText(sf) : '');
      } else if (name === 'withUserFileLock') {
        out.userCalls += 1;
      }
      // The callee's own name is accounted for; visit what it is called on and the arguments.
      node.arguments.forEach(visit);
      if (ts.isPropertyAccessExpression(node.expression)) visit(node.expression.expression);
      else if (!ts.isIdentifier(node.expression)) visit(node.expression);
      return;
    } else if (ts.isIdentifier(node) && LOCK_NAMES.has(node.text)) {
      const parent = node.parent;
      const declaration =
        ts.isImportSpecifier(parent) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isExportSpecifier(parent));
      if (!declaration) out.indirect.push(`${node.text} used as a value`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every .ts/.tsx file under src/, tracked or not (a new file must not slip past). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(path.join(repoRoot, 'src'));
  return out;
}

interface Scan { counts: Map<string, number>; indirect: string[]; userCalls: Map<string, number> }
let scanned: Scan | null = null;

/** One walk of src/ for the whole file (the tests only read it). */
function scan(): Scan {
  scanned ??= walkLocks();
  return scanned;
}

function walkLocks(): Scan {
  const counts = new Map<string, number>();
  const indirect: string[] = [];
  const userCalls = new Map<string, number>();
  for (const full of sourceFiles()) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (rel === 'src/utils/file-lock.ts') continue; // the lock itself
    const text = fs.readFileSync(full, 'utf-8');
    if (!/withFileLock|withUserFileLock/.test(text)) continue;
    const sites = findLockSites(rel, text);
    for (const arg of sites.calls) {
      const key = `${rel}: ${arg}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const what of sites.indirect) indirect.push(`${rel}: ${what}`);
    if (sites.userCalls) userCalls.set(rel, sites.userCalls);
  }
  return { counts, indirect, userCalls };
}

describe('user-file lock ratchet', () => {
  it('takes withFileLock only at the listed Walnut store sites', () => {
    const { counts } = scan();
    const offenders: string[] = [];
    for (const [key, n] of counts) {
      if (!STORE_LOCKS.has(key)) offenders.push(`${key} (${n} call(s))`);
    }
    expect(
      offenders,
      'withFileLock keeps its lock beside the file (`<file>.lock`). For a file a person edits, '
        + 'use withUserFileLock (src/utils/user-file-lock.ts). Only a path always inside '
        + "WALNUT_HOME or the daemon dir, outside the notes vault, may be added to STORE_LOCKS.",
    ).toEqual([]);
  });

  it('never takes the store lock through an alias or as a value', () => {
    expect(scan().indirect, 'call withFileLock by name, so this ratchet can see the call').toEqual([]);
  });

  it('locks every user-content writer with withUserFileLock', () => {
    const { userCalls } = scan();
    const missing = Object.entries(USER_CONTENT_WRITERS)
      .filter(([rel, n]) => (userCalls.get(rel) ?? 0) < n)
      .map(([rel, n]) => `${rel} (${userCalls.get(rel) ?? 0} of ${n})`);
    expect(missing).toEqual([]);
  });

  it('the scan sees the store sites at all (a broken walker would pass everything)', () => {
    const { counts } = scan();
    expect(counts.get('src/core/task-manager.ts: TASKS_FILE')).toBeGreaterThan(0);
    expect(counts.get('src/core/notes-indexer.ts: NOTES_INDEX_PATH')).toBeGreaterThan(0);
    // Every listed site is still there: an entry nothing calls any more is taken out.
    expect([...STORE_LOCKS].filter((key) => !counts.has(key))).toEqual([]);
  });

  it('reports the old way of locking a user file, and an alias', () => {
    const old = findLockSites(
      'src/web/routes/file-content.ts',
      "import { withFileLock } from '../../utils/file-lock.js'\n"
        + 'const conflict = await withFileLock(filePath, async () => null)\n'
        + '// withFileLock(commented) never counts\n'
        + "const s = 'withFileLock(inString)'\n",
    );
    expect(old.calls).toEqual(['filePath']);
    expect(old.indirect).toEqual([]);
    const sync = findLockSites('x.ts', 'lib.withFileLockSync(notePath, () => 1)\n');
    expect(sync.calls).toEqual(['notePath']);
    const alias = findLockSites(
      'x.ts',
      "import { withFileLock as lock } from './file-lock.js'\nawait lock(p, f)\nconst g = withFileLock\n",
    );
    expect(alias.indirect).toEqual(['import withFileLock as lock', 'withFileLock used as a value']);
  });
});
