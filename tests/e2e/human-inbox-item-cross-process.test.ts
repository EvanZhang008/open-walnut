import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { guardedPath } from '../setup/exec-guard-core.js';

const root = path.resolve(import.meta.dirname, '../..');
async function stopWorker(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(deadline); resolve(); };
    const deadline = setTimeout(() => {
      proc.off('exit', finish);
      reject(new Error('Fixture worker did not exit; keeping its data directory'));
    }, 10_000);
    proc.once('exit', finish);
    proc.kill('SIGTERM');
  });
}
async function worker(script: string, data: string, children: ChildProcess[]): Promise<{ id: string; reused: boolean }> {
  // bun runs the TypeScript worker as it is.
  const proc = spawn(process.execPath, [script], { cwd: data,
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: data, USERPROFILE: data, OPEN_WALNUT_HOME: data, NODE_ENV: 'test',
      CLAUDE_CONFIG_DIR: path.join(data, '.claude'), OPEN_WALNUT_API_URL: 'http://127.0.0.1:1', WALNUT_DISABLE_BACKGROUND_AI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let stdout = ''; let stderr = '';
  proc.stdout.on('data', bytes => { stdout += bytes; }); proc.stderr.on('data', bytes => { stderr += bytes; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture worker timed out')), 20_000);
    proc.once('error', error => { clearTimeout(timeout); reject(error); });
    proc.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Worker exit ${code}: ${stderr}`)); });
  });
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  if (!line) throw new Error(`Missing fixture result: ${stderr}`);
  return JSON.parse(line.slice(7));
}
describe('Cross-process source and create claims', () => {
  it('reserves one exact source ID across two writers and a restarted writer', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-cross-process-'));
    const data = path.join(dir, 'data'); await fs.mkdir(data);
    const script = path.join(dir, 'writer.mts');
    await fs.writeFile(script, `import { addTaskIdempotently } from ${JSON.stringify(path.join(root, 'src/core/task-create-idempotency.ts'))};
import { claimSourceTask, markSourceTaskCreated } from ${JSON.stringify(path.join(root, 'src/core/source-task-claims.ts'))};
const adapter = { legacyTaskId: async () => undefined, writeLegacy: async () => {} };
const claim = await claimSourceTask({ key: 'rfc:fixture-source', pair: '["account-a","message-a"]', adapter });
const result = await addTaskIdempotently({ title: 'Shared source work', project: '', description: 'Approved work' }, 'mail-source:rfc:fixture-source');
if (result.task.id !== claim.taskId) throw new Error('Identity mismatch');
await markSourceTaskCreated(claim.key, result.task.id);
process.stdout.write('RESULT ' + JSON.stringify({ id: result.task.id, reused: result.reused }) + '\\n');
process.exit(0);
`);
    const children: ChildProcess[] = [];
    try {
      const results = await Promise.all([worker(script, data, children), worker(script, data, children)]);
      expect(results[0].id).toBe(results[1].id);
      expect(results.filter(r => !r.reused)).toHaveLength(1);
      const restart = await worker(script, data, children);
      expect(restart).toEqual({ id: results[0].id, reused: true });
      const claims = JSON.parse(await fs.readFile(path.join(data, 'source-task-claims.json'), 'utf8'));
      expect(Object.values(claims.claims)).toHaveLength(1);
    } finally {
      const stopped = await Promise.allSettled(children.map(stopWorker));
      const failure = stopped.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
