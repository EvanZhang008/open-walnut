/**
 * The embed worker as a separate process (embedder.ts): the real worker entry
 * ends on its own, and a host that is a process of its own (a one-shot CLI, a
 * server shutting down) neither hangs on its worker nor leaves it behind.
 *
 * Every case here starts real node processes through tsx, which is why this
 * file is in the slow tier; the in-process stop protocol is in
 * hybrid-search-embed-worker-stop.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMBED_WORKER_CONFIG_ENV } from '../../src/lib/hybrid-search/embedder.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;
const FAKE_WORKER = new URL('./fixtures/fake-embed-worker.cjs', import.meta.url).pathname;
const REPO = path.resolve(import.meta.dirname, '..', '..');
const REAL_WORKER = path.join(REPO, 'src', 'lib', 'hybrid-search', 'embed-worker.ts');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('the real embed worker ends on its own', () => {
  // The real entry (embed-worker.ts) through tsx; no job is sent, so nothing
  // loads a model.
  function startRealWorker() {
    return fork(REAL_WORKER, [], {
      execArgv: ['--import', 'tsx'],
      cwd: REPO,
      serialization: 'advanced',
      env: { ...process.env, [EMBED_WORKER_CONFIG_ENV]: JSON.stringify({ modelId: 'none', dims: 4 }) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  }
  function exitOf(child: ReturnType<typeof fork>): Promise<number | null> {
    return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }
  it('on { stop: true }', async () => {
    const child = startRealWorker();
    const exit = exitOf(child);
    // Sent before the worker has loaded: IPC holds it until it listens.
    child.send({ stop: true });
    expect(await exit).toBe(0);
  }, 60_000);

  it('when its host goes away (the IPC channel closes)', async () => {
    const child = startRealWorker();
    const exit = exitOf(child);
    child.disconnect();
    expect(await exit).toBe(0);
  }, 60_000);

  it('the worker reads the config variable the host sets', () => {
    expect(fs.readFileSync(REAL_WORKER, 'utf8')).toContain(`process.env.${EMBED_WORKER_CONFIG_ENV}`);
  });
});

describe('a one-shot host and its worker', () => {
  // A separate node process running the real embedder through tsx: whether a
  // host stays alive, or exits, is exactly what a test inside vitest cannot see.
  let hostDir = '';
  afterEach(() => { if (hostDir) fs.rmSync(hostDir, { recursive: true, force: true }); hostDir = ''; });

  async function runHost(body: string[]): Promise<{ code: number | null; out: string; ms: number }> {
    hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-oneshot-'));
    const script = path.join(hostDir, 'host.mts');
    fs.writeFileSync(script, [
      `import { createEmbedder } from ${JSON.stringify(path.join(REPO, 'src', 'lib', 'hybrid-search', 'embedder.ts'))};`,
      `const dir = ${JSON.stringify(hostDir)};`,
      ...body,
    ].join('\n'));
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    const t0 = Date.now();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, out, ms: Date.now() - t0 };
  }
  const busy = (knobs: Record<string, unknown>) =>
    `createEmbedder({ modelId: 'fake/busy:' + JSON.stringify({ markerFile: dir + '/marks.txt', ...${JSON.stringify(knobs)} }), dims: 4, workerPath: ${JSON.stringify(BUSY_WORKER)} }, () => {}, { stopGraceMs: 200 })`;
  const hostMarks = () => fs.readFileSync(path.join(hostDir, 'marks.txt'), 'utf8').split('\n').filter(Boolean);

  it('exits once its own work is done, without dispose()', async () => {
    const { code, out, ms } = await runHost([
      `const e = createEmbedder({ modelId: 'fake/unit-x', dims: 4, workerPath: ${JSON.stringify(FAKE_WORKER)} }, () => {});`,
      `const r = await e.embedQuery('hello', 20_000);`,
      `console.log('answer', r?.source, Array.from(r?.vec ?? []).join(','));`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('answer worker 127,0,0,0');
    // The idle worker would hold it for as long as the worker lives.
    expect(ms).toBeLessThan(45_000);
  }, 60_000);

  it('waits for a passage embed it awaits', async () => {
    const { code, out } = await runHost([
      `const e = ${busy({ holdMs: 1500 })};`,
      `const rows = await e.embedPassages(['a slow passage']);`,
      `console.log('rows', rows.length);`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('rows 1');
  }, 60_000);

  it('dispose() resolves even when the worker has to be killed', async () => {
    const { code, out } = await runHost([
      `const e = ${busy({ ignoreStop: true })};`,
      `await e.embedPassages(['quick one']);`,
      `await e.dispose();`,
      `console.log('disposed');`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('disposed');
  }, 60_000);

  it('a host that exits in the middle of a run takes its worker with it', async () => {
    const { code } = await runHost([
      `const e = ${busy({ holdMs: 20_000, markPid: true })};`,
      `void e.embedPassages(['a slow passage']).catch(() => {});`,
      `await new Promise((r) => setTimeout(r, 500));`,
      `process.exit(0);`,
    ]);
    expect(code).toBe(0);
    const pid = Number(hostMarks()[0].split(' ')[1]);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
    expect(hostMarks()).toEqual([`pid ${pid}`]);
  }, 60_000);
});
