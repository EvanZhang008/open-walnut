/**
 * 'history-ready-v1' reaches every host the same way (src/providers/history-ready-core.ts).
 *
 * Mostly source reads. One block builds the source twin's sidecar (bun build, into a temp dir)
 * and starts it as a worker THREAD in this process, flagged as daemon-source.ts starts it: no
 * daemon, no child process past the build, no signal. The real daemons answer in
 * history-ready-twins-e2e.test.ts. Both daemon twins dispatch history.readyView and
 * history.readyKeys; the binary imports the core, the source twin requires its sidecar and
 * advertises the capability only when that loads; the commands stay off the bridge; the sidecar
 * is built and deployed to remote hosts and to this Mac's own daemon; and the parser the core
 * bundles (history-parse.ts and every lean module it reaches) is in both version-hash lists, so a
 * parser change ships a new daemon. The parser itself stays one module with the server's copy,
 * and reaches none of the server-only modules (logging, constants); the parser does no I/O.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import * as historyParse from '../../src/core/history-parse.js';
import * as sessionHistory from '../../src/core/session-history.js';
import { HISTORY_PARSER_VERSION } from '../../src/core/history-parser-version.js';
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js';
import { decodeReadyRows, type ReadyWorkerLike } from '../../src/providers/history-ready-core.js';
import { testBun } from '../helpers/bun-runtime.js';
import { transcript } from '../helpers/transcript-fixtures.js';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe("'history-ready-v1' in both twins", () => {
  const standalone = read('src/providers/daemon-standalone.ts');
  const template = read('src/providers/daemon-source.ts');

  it('both dispatch the two commands', () => {
    for (const src of [standalone, template]) {
      expect(src).toMatch(/case 'history\.readyView': return cmdHistoryReadyView\(ws, id/);
      expect(src).toMatch(/case 'history\.readyKeys': return cmdHistoryReadyKeys\(ws, id/);
      expect(src).toMatch(/function cmdHistoryReadyView\(/);
      expect(src).toMatch(/function cmdHistoryReadyKeys\(/);
    }
    expect(standalone).toMatch(/from '\.\/history-ready-core\.js'/);
    expect(template).toMatch(/require\(path\.join\(__dirname, 'history-ready-core\.cjs'\)\)/);
  });

  it('the source twin advertises it only once its sidecar loads, and refuses cleanly without', () => {
    const gatedStart = template.indexOf('SIDECAR_GATED_CAPABILITIES = new Set([');
    expect(gatedStart).toBeGreaterThan(-1);
    expect(template.slice(gatedStart, template.indexOf('])', gatedStart))).toContain("'history-ready-v1'");
    expect(template).toMatch(/if \(historyReadyCore && typeof historyReadyCore\.createHistoryReady === 'function'\) caps\.push\('history-ready-v1'\)/);
    expect(template).toMatch(/history\.readyView: core sidecar not available/);
  });

  it('is advertised, never required, and not reachable over the bridge', () => {
    const caps = read('src/providers/daemon-capabilities.ts');
    const req = caps.indexOf('REQUIRED_DAEMON_CAPABILITIES = [');
    expect(caps.slice(req, caps.indexOf('] as const', req))).not.toMatch(/'history-ready-v1'/);
    const adv = caps.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [');
    expect(caps.slice(adv, caps.indexOf('] as const', adv))).toMatch(/'history-ready-v1'/);
    for (const src of [standalone, template]) {
      const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([');
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf('])', start))).not.toMatch(/history\.ready/);
    }
  });

  it('the sidecar is built and deployed, remote and local', () => {
    const build = read('scripts/build-daemon.sh');
    expect(build).toMatch(/--outfile "\$OUTDIR\/history-ready-core\.cjs"/);
    expect(read('src/providers/daemon-connection.ts')).toMatch(/'history-ready-core\.cjs'/);
    expect(read('src/providers/local-daemon.ts')).toMatch(/'history-ready-core\.cjs'/);
  });

  it('builds run in a worker thread in both twins, never on the daemon loop', () => {
    // The binary: the worker entry is compiled in beside the daemon, in every compile.
    const build = read('scripts/build-daemon.sh');
    const compiles = [...build.matchAll(/--outfile "\$OUTDIR\/daemon-[\w-]+" \\\n\s*src\/providers\/daemon-standalone\.ts([^\n]*)/g)];
    expect(compiles.length).toBe(3);
    for (const m of compiles) expect(m[1]).toContain('src/providers/history-ready-worker.ts');
    // The Walnut file runs the same daemon: its build compiles the worker entry in too.
    expect(read('scripts/build-binary.mjs')).toMatch(/entrypoints: \[path\.join\(repo, 'src\/binary\/main\.ts'\), path\.join\(repo, 'src\/providers\/history-ready-worker\.ts'\)\]/);
    expect(standalone).toMatch(/const historyReadyExecutor = createReadyWorkerExecutor\(/);
    expect(standalone).toMatch(/executor: historyReadyExecutor/);
    expect(standalone).toMatch(/void historyReadyExecutor\.warm\(\)/);
    expect(standalone).toMatch(/readyWorkerEntries\(historyReadyMain, import\.meta\.url\)/);
    // The source twin starts its own sidecar as the worker, flagged.
    expect(template).toMatch(/historyReadyExecutor = historyReadyCore\.createReadyWorkerExecutor\(\[/);
    expect(template).toMatch(/executor: historyReadyExecutor/);
    expect(template).toMatch(/void historyReadyExecutor\.warm\(\)/);
    expect(template).toMatch(/new WorkerThread\(sidecar, \{ workerData: \{ walnutHistoryReadyWorker: true \} \}\)/);
    expect(read('src/providers/history-ready-core.ts')).toMatch(/walnutHistoryReadyWorker === true\) \{\n\s*serveReadyWorker\(parentPort\);/);
    // No twin ever builds in its own thread, nor reads the rewind dead set there for it.
    for (const src of [standalone, template]) expect(src).not.toMatch(/inThreadReadyExecutor|buildReadyView/);
    for (const src of [standalone, template]) {
      const start = src.search(/createHistoryReady\(\{/);
      expect(src.slice(start, src.indexOf('})', start))).not.toMatch(/probeRewind|probeTranscriptRewind/);
    }
    // In the core, the whole-file dead set is read only inside buildReadyView (the worker's code).
    const core = read('src/providers/history-ready-core.ts');
    const calls = [...core.matchAll(/rewindDeadSetAtPath\(/g)].map((m) => m.index!);
    const buildStart = core.indexOf('export async function buildReadyView(');
    const buildEnd = core.indexOf('\n}\n', buildStart);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeGreaterThan(buildStart);
    expect(calls[0]).toBeLessThan(buildEnd);
  });

  it('every module the ready view bundles (core and worker) is in both version-hash lists', () => {
    const build = read('scripts/build-daemon.sh');
    const versionCheck = read('src/providers/daemon-version-check.ts');
    const bundled = new Set<string>();
    const walk = (rel: string): void => {
      if (bundled.has(rel)) return;
      bundled.add(rel);
      const src = read(rel);
      for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
        const target = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), m[1]!.replace(/\.js$/, '.ts')));
        if (fs.existsSync(path.join(ROOT, target))) walk(target);
      }
    };
    walk('src/providers/history-ready-core.ts');
    walk('src/providers/history-ready-worker.ts');
    expect(bundled).toContain('src/core/history-parse.ts');
    const missing = [...bundled].filter((rel) => !build.includes(rel) || !versionCheck.includes(`'${rel}'`));
    expect(missing, `bundled into the ready view but not hashed: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('one parser', () => {
  it("the server's parse is the parse the daemon bundles", () => {
    expect(sessionHistory.parseSessionMessages).toBe(historyParse.parseSessionMessages);
    expect(sessionHistory.rewindCutsKey).toBe(historyParse.rewindCutsKey);
    expect(sessionHistory.HISTORY_CACHE_SCHEMA).toBe(historyParse.HISTORY_CACHE_SCHEMA);
  });

  it('reaches none of the server-only modules (it runs inside every daemon), and the parser no I/O', () => {
    // The static, value-level import graph of one entry point: its files and each import edge.
    const closure = (entry: string): { files: Set<string>; edges: string[] } => {
      const files = new Set<string>();
      const edges: string[] = [];
      const walk = (file: string): void => {
        if (files.has(file)) return;
        files.add(file);
        const src = fs.readFileSync(file, 'utf-8');
        for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
          const spec = m[1]!;
          if (!spec.startsWith('.')) { edges.push(`${path.relative(ROOT, file)} -> ${spec}`); continue; }
          const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
          edges.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
          if (fs.existsSync(target)) walk(target);
        }
      };
      walk(path.join(ROOT, entry));
      return { files, edges };
    };
    const serverOnly = (edge: string) => / -> src\/(logging\/|constants\.ts$|core\/session-history\.ts$)/.test(edge);
    const parser = closure('src/core/history-parse.ts');
    expect(parser.edges.filter(serverOnly)).toEqual([]);
    expect(parser.edges.filter((e) => / -> (node:)?(fs|fs\/promises|child_process|net|http|https)$/.test(e))).toEqual([]);
    const core = closure('src/providers/history-ready-core.ts');
    expect(core.edges.filter(serverOnly)).toEqual([]);
    expect(core.files.has(path.join(ROOT, 'src/core/history-parse.ts'))).toBe(true);
  });
});

describe.skipIf(!testBun())("the source twin's sidecar, as its worker (a thread here)", () => {
  it('builds a ready view in the sidecar started with workerData.walnutHistoryReadyWorker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ready-sidecar-'));
    try {
      const out = path.join(dir, 'history-ready-core.cjs');
      const built = spawnSync(testBun()!, ['build', '--target=node', '--format=cjs', '--outfile', out, path.join(ROOT, 'src/providers/history-ready-core.ts')], { encoding: 'utf8' });
      expect(built.status, built.stderr).toBe(0);
      const claudeHome = path.join(dir, 'claude');
      const cwd = '/proj/sidecar';
      fs.mkdirSync(path.join(claudeHome, 'projects', encodeProjectPathCore(cwd)), { recursive: true });
      fs.writeFileSync(path.join(claudeHome, 'projects', encodeProjectPathCore(cwd), 'sidecar-sid.jsonl'),
        transcript().user('u1', 'from the sidecar \u00e9').assistant('a1', 'Answered.').text());
      // Exactly what daemon-source.ts historyReadyInstance does, with the sidecar's own exports.
      const core = createRequire(import.meta.url)(out) as typeof import('../../src/providers/history-ready-core.js');
      const ex = core.createReadyWorkerExecutor([
        () => new Worker(out, { workerData: { walnutHistoryReadyWorker: true } }) as unknown as ReadyWorkerLike,
      ]);
      try {
        const ready = core.createHistoryReady({ executor: ex });
        const view = await ready.readyView({ sessionId: 'sidecar-sid', cwd, claudeHome, budgetMs: 15_000 });
        expect(view.status, JSON.stringify(view)).toBe('ready');
        if (view.status !== 'ready') return;
        expect(view.parser).toBe(HISTORY_PARSER_VERSION);
        expect(decodeReadyRows(view).map((m) => m.text)).toEqual(['from the sidecar \u00e9', 'Answered.']);
        expect(ex._alive()).toBe(true); // it ran in the worker, not in this thread
      } finally {
        ex.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
