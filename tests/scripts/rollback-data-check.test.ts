import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkRollbackData, ROLLBACK_CHECK_TIMEOUT_MS, SESSIONS_SPLIT_REFUSAL } from '../../scripts/lib/rollback-data-check.mjs';

const roots: string[] = [];
async function fixture(version?: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-rollback-data-test.'));
  roots.push(root);
  const home = path.join(root, 'live');
  await fs.mkdir(path.join(home, 'tasks'), { recursive: true });
  const file = path.join(home, 'tasks/tasks.sqlite');
  if (version !== undefined) {
    const db = new Database(file);
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)');
    db.close();
  }
  return { root, home, file };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('rollback checks the old build on an isolated database copy', () => {
  it('copies committed WAL pages and runs only a bounded direct task read', async () => {
    const f = await fixture(13);
    const writer = new Database(f.file);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    writer.exec('PRAGMA user_version = 14');
    writer.query('INSERT INTO tasks VALUES (?, ?)').run('fixture', 'Neutral note');
    const before = await fs.readFile(f.file);
    const walBefore = await fs.readFile(`${f.file}-wal`);
    let checkRoot = '';
    const run = vi.fn(async (binary, args, options) => {
      expect(binary).toBe('/fixture/walnut');
      expect(args).toEqual(['--json', 'tasks', '--project', '__rollback_compatibility_probe__']);
      expect(options).toMatchObject({ timeout: ROLLBACK_CHECK_TIMEOUT_MS, killSignal: 'SIGTERM', maxBuffer: 65536 });
      expect(options.env).toMatchObject({ WALNUT_CLI_DIRECT: '1', WALNUT_SESSION_HOST: '0', WALNUT_NO_AUTO_UPDATE: '1' });
      expect(options.env).not.toHaveProperty('WALNUT_SESSION_ID');
      expect(options.env).not.toHaveProperty('BUN_BE_BUN');
      checkRoot = options.cwd;
      expect(options.env.OPEN_WALNUT_HOME).not.toBe(f.home);
      const copy = new Database(path.join(options.env.OPEN_WALNUT_HOME, 'tasks/tasks.sqlite'));
      try {
        expect(copy.query('PRAGMA user_version').get()).toEqual({ user_version: 14 });
        expect(copy.query('SELECT title FROM tasks WHERE id = ?').get('fixture')).toEqual({ title: 'Neutral note' });
        copy.exec('PRAGMA user_version = 7');
      } finally { copy.close(); }
      return { stdout: '[]', stderr: '' };
    });
    try {
      expect(await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).toEqual({ checked: true, version: 14 });
      expect(await fs.readFile(f.file)).toEqual(before);
      expect(await fs.readFile(`${f.file}-wal`)).toEqual(walBefore);
      expect(writer.query('PRAGMA user_version').get()).toEqual({ user_version: 14 });
      await expect(fs.access(checkRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { writer.close(); }
  });

  it('reads a checkpointed WAL database with missing side files and preserves its content', async () => {
    const f = await fixture(13);
    const writer = new Database(f.file);
    writer.exec('PRAGMA journal_mode = WAL; INSERT INTO tasks VALUES (\'closed\', \'Checkpointed note\')');
    writer.close();
    await fs.rm(`${f.file}-wal`, { force: true });
    await fs.rm(`${f.file}-shm`, { force: true });
    const before = await fs.readFile(f.file);
    const run = vi.fn(async (_file, _args, options) => {
      const copy = new Database(path.join(options.env.OPEN_WALNUT_HOME, 'tasks/tasks.sqlite'), { readonly: true });
      try { expect(copy.query('SELECT title FROM tasks WHERE id = ?').get('closed')).toEqual({ title: 'Checkpointed note' }); }
      finally { copy.close(); }
      return { stdout: '[]', stderr: '' };
    });
    expect(await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).toEqual({ checked: true, version: 13 });
    expect(await fs.readFile(f.file)).toEqual(before);
    const current = new Database(f.file, { readonly: true });
    try {
      expect(current.query('PRAGMA user_version').get()).toEqual({ user_version: 13 });
      expect(current.query('SELECT title FROM tasks WHERE id = ?').get('closed')).toEqual({ title: 'Checkpointed note' });
    } finally { current.close(); }
  });

  it('keeps the old build\'s exact newer-data refusal, with no second execution', async () => {
    const f = await fixture(14);
    const refusal = 'Task database schema 14 is newer than supported schema 13; use a newer Walnut build.';
    const run = vi.fn(async () => { throw Object.assign(new Error('exit 1'), { stderr: `Error: ${refusal}` }); });
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow(refusal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(f.root)).toEqual(['live']);
  });

  it.each(['timeout', 'invalid-output'])('refuses an unverifiable %s result', async (why) => {
    const f = await fixture(13);
    const run = vi.fn(async () => {
      if (why === 'timeout') throw Object.assign(new Error('timed out'), { killed: true });
      return { stdout: '{}', stderr: '' };
    });
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow('rollback was not started');
  });

  it('never creates a missing source database, and refuses an area registry with no database', async () => {
    const f = await fixture();
    const run = vi.fn();
    expect(await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).toMatchObject({ checked: false });
    await fs.mkdir(path.join(f.home, 'router'));
    await fs.writeFile(path.join(f.home, 'router/areas.json'), '{}');
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow('without a task store');
    expect(run).not.toHaveBeenCalled();
    await expect(fs.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a corrupt task store before executing any old code', async () => {
    const f = await fixture();
    await fs.writeFile(f.file, 'not sqlite');
    const run = vi.fn();
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual(['live']);
  });

  it('the real deploy refuses before staging or launching an incompatible rollback', async () => {
    const script = await fs.readFile(path.resolve(import.meta.dirname, '../../scripts/dev-prod.sh'), 'utf8');
    const start = script.indexOf('rollback_to_lkg() {');
    const end = script.indexOf('\n}\n', start);
    const body = script.slice(start, end);
    const guard = body.indexOf('rollback-data-check.mjs');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf('stage_lkg_for_rollback'));
    expect(guard).toBeLessThan(body.indexOf('launch_server'));
    expect(body.slice(guard, body.indexOf('stage_lkg_for_rollback'))).toContain('return 0');
  });
});

/** A session store with one row in `shape`: the old one (text in the payload) or the split one (only its stub). */
async function sessionsFixture(home: string, shape: 'old' | 'split'): Promise<string> {
  const file = path.join(home, 'sessions.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, payload TEXT)');
  const payload = shape === 'old'
    ? { appliedAppendSystemPrompt: 'spawn', profile: { systemPrompt: 'persona' } }
    : { appliedAppendSystemPromptRef: { sha256: 'x', bytes: 5 }, profile: { systemPromptRef: { sha256: 'y', bytes: 7, blank: false } } };
  db.query('INSERT INTO sessions VALUES (?, ?)').run('s1', JSON.stringify(payload));
  db.close();
  return file;
}

describe('rollback checks that the old build reads the session store\'s prompt split', () => {
  it('refuses a build without the store-format probe when prompts live only in session_prompts', async () => {
    const f = await fixture(13);
    await sessionsFixture(f.home, 'split');
    const run = vi.fn(async (_file, args) => {
      if (args[1] === 'store-formats') throw Object.assign(new Error('exit 1'), { stderr: "error: unknown command 'store-formats'" });
      return { stdout: '[]', stderr: '' };
    });
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow(SESSIONS_SPLIT_REFUSAL);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(f.root)).toEqual(['live']);
  });

  it('passes a build that answers the probe, in an isolated home', async () => {
    const f = await fixture(13);
    await sessionsFixture(f.home, 'split');
    const run = vi.fn(async (_file, args, options) => {
      expect(options.env.OPEN_WALNUT_HOME).not.toBe(f.home);
      expect(options.env).toMatchObject({ WALNUT_CLI_DIRECT: '1' });
      return { stdout: args[1] === 'store-formats' ? '{"sessionsPromptSplit":1}' : '[]', stderr: '' };
    });
    expect(await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run }))
      .toEqual({ checked: true, version: 13, sessions: { splitRows: 1, sessionsPromptSplit: 1 } });
    expect(run.mock.calls.map((c) => c[1][1])).toEqual(['store-formats', 'tasks']);
  });

  it('asks nothing of any build on unsplit data (release A\'s, or an older build\'s)', async () => {
    const f = await fixture(13);
    await sessionsFixture(f.home, 'old');
    const run = vi.fn(async () => ({ stdout: '[]', stderr: '' }));
    expect(await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run }))
      .toEqual({ checked: true, version: 13, sessions: { splitRows: 0 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a build that says it has no such command, as 0.6.37 does', async () => {
    const f = await fixture(13);
    await sessionsFixture(f.home, 'split');
    const run = vi.fn(async (_file, args) => {
      if (args[1] === 'store-formats') throw Object.assign(new Error('Command failed'), { code: 1, killed: false, signal: null, stdout: '', stderr: 'error: too many arguments.\nUnknown command: store-formats\n' });
      return { stdout: '[]', stderr: '' };
    });
    await expect(checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run })).rejects.toThrow(SESSIONS_SPLIT_REFUSAL);
  });

  it('lets a rollback go on, with a warning, when the build never finished answering (a timeout, a file that does not start)', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const failure of [
        Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' }),
        Object.assign(new Error('spawn /fixture/walnut ENOENT'), { code: 'ENOENT' }),
      ]) {
        const f = await fixture(13);
        await sessionsFixture(f.home, 'split');
        const run = vi.fn(async (_file, args) => {
          if (args[1] === 'store-formats') throw failure;
          return { stdout: '[]', stderr: '' };
        });
        const result = await checkRollbackData({ file: '/fixture/walnut', home: f.home, tmpDir: f.root, run });
        expect(result.sessions).toMatchObject({ splitRows: 1, sessionsPromptSplit: null, probe: expect.stringMatching(/^no answer: /) });
        expect(run.mock.calls.map((c) => c[1][1])).toEqual(['store-formats', 'tasks']);
      }
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('did not answer the store-format probe'))).toHaveLength(2);
    } finally { warn.mockRestore(); }
  });
});
