import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database, { sqliteLibrary, sqliteLibraryProblem } from '../../src/lib/sqlite.ts';

// Load Walnut's library before any raw bun:sqlite open, including a caller's test fixture.
if (process.platform === 'darwin') sqliteLibrary();

const execute = promisify(execFile);
export const ROLLBACK_CHECK_TIMEOUT_MS = 45_000;

export async function checkRollbackData({ file, home, tmpDir = os.tmpdir(), run = execute }) {
  if (!path.isAbsolute(file) || !path.isAbsolute(home)) throw new Error('Rollback check needs absolute file and data paths.');
  if (process.platform === 'darwin' && sqliteLibraryProblem()) throw new Error(sqliteLibraryProblem());
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
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CFFIXED_USER_HOME: path.join(root, 'home'),
      TMPDIR: root, OPEN_WALNUT_HOME: data, WALNUT_CLI_DIRECT: '1', WALNUT_NO_AUTO_UPDATE: '1',
      WALNUT_RUNTIME_DIR: path.join(root, 'runtime'), WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
      WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
      WALNUT_SESSION_HOST: '0', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1',
      WALNUT_STT_AUTO_SETUP: '0', WALNUT_ORG_AUTOSTART: '0', WALNUT_LOCAL_CLAUDE_PROBE: '0',
    };
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
