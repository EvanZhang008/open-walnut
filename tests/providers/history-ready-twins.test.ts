/**
 * 'history-ready-v1' reaches every host the same way (src/providers/history-ready-core.ts).
 *
 * Source reads only: no daemon, no child process, no signal. The real daemons answer in
 * history-ready-twins-e2e.test.ts. The daemon dispatches history.readyView and
 * history.readyKeys from the core it imports; the commands stay off the bridge; and the parser
 * the core bundles (history-parse.ts and every lean module it reaches) is in both version-hash lists, so a
 * parser change ships a new daemon. The parser itself stays one module with the server's copy,
 * and reaches none of the server-only modules (logging, constants); the parser does no I/O.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as historyParse from '../../src/core/history-parse.js';
import * as sessionHistory from '../../src/core/session-history.js';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe("'history-ready-v1' in the daemon", () => {
  const standalone = read('src/providers/daemon-standalone.ts');

  it('dispatches the two commands from the core it imports', () => {
    expect(standalone).toContain("['transcripts', transcripts.answers]");
    // The two commands are the daemon's transcript module (daemon-transcripts.ts), handed the runtime's historyReady.
    const transcripts = read('src/providers/daemon-transcripts.ts');
    expect(transcripts).toMatch(/function cmdHistoryReadyView\(/);
    expect(transcripts).toMatch(/function cmdHistoryReadyKeys\(/);
    expect(transcripts).toMatch(/'history\.readyView': cmdHistoryReadyView, 'history\.readyKeys': cmdHistoryReadyKeys\b/);
    expect(standalone).toMatch(/createDaemonTranscripts\(\{[^}]*\bhistoryReady\b/);
    expect(standalone).toMatch(/from '\.\/history-ready-core\.js'/);
    expect(transcripts).toMatch(/from '\.\/history-ready-core\.js'/);
  });

  it('is advertised, never required, and not reachable over the bridge', () => {
    const caps = read('src/providers/daemon-capabilities.ts');
    const req = caps.indexOf('REQUIRED_DAEMON_CAPABILITIES = [');
    expect(caps.slice(req, caps.indexOf('] as const', req))).not.toMatch(/'history-ready-v1'/);
    const adv = caps.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [');
    expect(caps.slice(adv, caps.indexOf('] as const', adv))).toMatch(/'history-ready-v1'/);
    const start = standalone.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([');
    expect(start).toBeGreaterThan(-1);
    expect(standalone.slice(start, standalone.indexOf('])', start))).not.toMatch(/history\.ready/);
  });

  it('builds run in a worker thread, never on the daemon loop', () => {
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
    // The daemon never builds in its own thread, nor reads the rewind dead set there for it.
    expect(standalone).not.toMatch(/inThreadReadyExecutor|buildReadyView/);
    const start = standalone.search(/createHistoryReady\(\{/);
    expect(standalone.slice(start, standalone.indexOf('})', start))).not.toMatch(/probeRewind|probeTranscriptRewind/);
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
