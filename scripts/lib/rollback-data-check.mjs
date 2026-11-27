import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database, { sqliteLibrary, sqliteLibraryProblem } from '../../src/lib/sqlite.ts';
import { SPLIT_PROMPT_ROWS_SQL } from '../../src/core/session-prompts.ts';
import { STORE_FORMAT_PROBE_TIMEOUT_MS, isolatedBuildEnv, probeStoreFormats } from '../../src/core/store-format-probe.ts';

// Load Walnut's library before any raw bun:sqlite open, including a caller's test fixture.
if (process.platform === 'darwin') sqliteLibrary();

const execute = promisify(execFile);
export const ROLLBACK_CHECK_TIMEOUT_MS = STORE_FORMAT_PROBE_TIMEOUT_MS;

export const SESSIONS_SPLIT_REFUSAL = 'sessions.sqlite has prompts in session_prompts that this build cannot read; run `walnut sessions-prompts unsplit` from the newer build first.';

/**
 * The session store's prompt split (src/core/session-prompts.ts): a file with rows whose prompts
 * live only in session_prompts needs a build that reads them. Such a build answers the store-format
 * probe; a build before the split says it has no such command, and is refused. A build that does
 * not finish answering (a timeout, a crash) is let through with a warning. Null: no session store.
 */
async function checkSessionsShape({ file, home, tmpDir, run }) {
  const source = path.join(home, 'sessions.sqlite');
  try { await fs.access(source); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const db = new Database(source, { readonly: true, fileMustExist: true });
  let split;
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
    split = hasTable ? Number(db.prepare(SPLIT_PROMPT_ROWS_SQL).get().n) : 0;
  } finally { db.close(); }
  if (split === 0) return { splitRows: 0 };
  const answer = await probeStoreFormats(file, { tmpDir, run, timeoutMs: ROLLBACK_CHECK_TIMEOUT_MS });
  // A build that never finished answering is not refused on it: a rollback goes on, as the launcher
  // starts a version whose check could not run (a dark Mac is worse). It is said, at warn.
  if ('noAnswer' in answer) {
    process.stderr.write(`Rollback data check: warn: the build did not answer the store-format probe (${answer.noAnswer}); not refused on the session store's prompt split.\n`);
    return { splitRows: split, sessionsPromptSplit: null, probe: `no answer: ${answer.noAnswer}` };
  }
  if (!(Number(answer.formats.sessionsPromptSplit) >= 1)) throw new Error(SESSIONS_SPLIT_REFUSAL);
  return { splitRows: split, sessionsPromptSplit: Number(answer.formats.sessionsPromptSplit) };
}

export async function checkRollbackData({ file, home, tmpDir = os.tmpdir(), run = execute }) {
  if (!path.isAbsolute(file) || !path.isAbsolute(home)) throw new Error('Rollback check needs absolute file and data paths.');
  if (process.platform === 'darwin' && sqliteLibraryProblem()) throw new Error(sqliteLibraryProblem());
  const sessions = await checkSessionsShape({ file, home, tmpDir, run });
  const tasks = await checkTaskStore({ file, home, tmpDir, run });
  return sessions ? { ...tasks, sessions } : tasks;
}

async function checkTaskStore({ file, home, tmpDir, run }) {
  const source = path.join(home, 'tasks', 'tasks.sqlite');
  try { await fs.access(source); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await fs.access(path.join(home, 'router', 'areas.json')); } catch (absent) {
      if (absent.code === 'ENOENT') return { checked: false, reason: 'No task store exists yet.' };
      throw absent;
    }
    throw new Error('The area registry exists without a task store; rollback compatibility cannot be checked.');
  }
  const root = await fs.mkdtemp(path.join(tmpDir, 'walnut-rollback-check.'));
  try {
    const data = path.join(root, 'data');
    const tasks = path.join(data, 'tasks');
    await fs.mkdir(tasks, { recursive: true });
    await fs.mkdir(path.join(root, 'home'), { mode: 0o700 });
    const db = new Database(source, { readonly: true, fileMustExist: true });
    let version;
    try {
      // serialize includes committed WAL pages; the old build never opens the user's database.
      const snapshot = db.transaction(() => ({ version: db.prepare('PRAGMA user_version').get().user_version, bytes: db.serialize() }))();
      version = snapshot.version;
      await fs.writeFile(path.join(tasks, 'tasks.sqlite'), snapshot.bytes);
    } finally { db.close(); }
    const env = isolatedBuildEnv(root, data);
    try {
      const result = await run(file, ['--json', 'tasks', '--project', '__rollback_compatibility_probe__'], {
        cwd: root, env, timeout: ROLLBACK_CHECK_TIMEOUT_MS, killSignal: 'SIGTERM', maxBuffer: 64 * 1024,
      });
      if (!Array.isArray(JSON.parse(result.stdout))) throw new Error('The old build did not return a task list.');
    } catch (error) {
      const refusal = String(error.stderr ?? '').match(/Task database schema \d+ is newer than supported schema \d+; use a newer Walnut build\./)?.[0];
      throw new Error(refusal ?? `The last-known-good build could not read a copy of task schema ${version}; rollback was not started.`);
    }
    return { checked: true, version };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await checkRollbackData({ file: process.argv[2] ?? '', home: process.argv[3] ?? '' });
    process.stdout.write(`Rollback data check: ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Rollback refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
