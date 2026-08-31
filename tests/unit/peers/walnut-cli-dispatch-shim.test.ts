/**
 * The on-host `walnut` CLI: argv dispatch keyword + the PATH shim the daemon
 * writes for it.
 *
 * Two things are pinned here, both of which broke in the field:
 *
 *  1. DISPATCH ACCEPTS BOTH KEYWORDS. `walnut` is canonical, `wn` is a
 *     deprecated compat alias. A shim is only rewritten when its own daemon next
 *     boots, so every shim written by a daemon deployed before the rename still
 *     execs `<artifact> wn …`. Dropping the alias would break `walnut` inside
 *     every already-running session on such a host.
 *  2. THE SHIM MUST EXEC A PATH THAT OUTLIVES THE DAEMON. On the hub the daemon
 *     binary boots from a stage temp dir (dev-prod clones dist/ before launching)
 *     which the NEXT deploy deletes. A shim holding `process.execPath` then
 *     pointed at nothing and every `walnut` call inside a live session exited
 *     126. The daemon now copies the artifact to `<daemon dir>/bin/walnut-core`
 *     (stable) and the shim execs the copy.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DAEMON_CLI_KEYWORD,
  DAEMON_CLI_KEYWORD_LEGACY,
  gatewayShimScript,
  isDaemonCliKeyword,
  SHIM_CORE_BASENAME,
  shimCoreNeedsCopy,
  shimQuote,
} from '../../../src/providers/gateway-core.js';

const ROOT = path.resolve(__dirname, '../../..');
const standaloneSrc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8');
const templateSrc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8');

describe('daemon CLI dispatch keyword', () => {
  it('accepts the canonical name and the deprecated alias, nothing else', () => {
    expect(DAEMON_CLI_KEYWORD).toBe('walnut');
    expect(DAEMON_CLI_KEYWORD_LEGACY).toBe('wn');
    expect(isDaemonCliKeyword('walnut')).toBe(true);
    expect(isDaemonCliKeyword('wn')).toBe(true);
    for (const other of ['--start', '--stop', '--status', '--version', 'walnutx', 'w', '', undefined, null]) {
      expect(isDaemonCliKeyword(other as string | undefined)).toBe(false);
    }
  });

  it('both daemon twins route BOTH keywords into the CLI, never into the usage error', () => {
    // Bun twin: imports the shared predicate.
    expect(standaloneSrc).toMatch(/if \(isDaemonCliKeyword\(action\)\) \{/);
    expect(standaloneSrc).toMatch(/const \{ runWalnutCli \} = await import\('\.\/wn-cli\.js'\)/);
    expect(standaloneSrc).not.toMatch(/if \(action === 'wn'\)/);
    // Node twin cannot import — the predicate is hand-inlined with both names…
    expect(templateSrc).toMatch(
      /var isDaemonCliKeyword = function \(a\) \{ return a === 'walnut' \|\| a === 'wn'; \};/,
    );
    expect(templateSrc).toMatch(/if \(isDaemonCliKeyword\(action\)\) \{/);
    // …and the trailing usage branch must exempt BOTH, or `walnut …` would print
    // "Usage: node daemon.js …" and exit 1 while the CLI was still running.
    expect(templateSrc).toMatch(/\} else if \(!isDaemonCliKeyword\(action\)\) \{/);
    expect(templateSrc).not.toMatch(/action !== 'wn'/);
  });

  it('the bun twin keeps CLI argv out of the --version fast path for both keywords', () => {
    // `walnut tools call session_send '{"text":"… --version …"}'` must not print
    // the daemon version and exit 0.
    expect(standaloneSrc).toMatch(
      /if \(process\.argv\.includes\('--version'\) && !isDaemonCliKeyword\(process\.argv\[2\]\)\) \{/,
    );
  });

  it('the usage lines advertise the canonical keyword', () => {
    expect(standaloneSrc).toMatch(/--version \| walnut <args\.\.\.>/);
    expect(templateSrc).toMatch(/--status \| walnut <args\.\.\.>/);
    expect(standaloneSrc).not.toMatch(/--version \| wn <args\.\.\.>/);
    expect(templateSrc).not.toMatch(/--status \| wn <args\.\.\.>/);
  });
});

describe('gatewayShimScript', () => {
  it('always passes the canonical keyword, never the legacy alias', () => {
    expect(gatewayShimScript(['/tmp/open-walnut/bin/walnut-core']))
      .toBe("#!/bin/sh\nexec '/tmp/open-walnut/bin/walnut-core' walnut \"$@\"\n");
    expect(gatewayShimScript(['/usr/bin/node', '/tmp/open-walnut/daemon.cjs']))
      .toBe("#!/bin/sh\nexec '/usr/bin/node' '/tmp/open-walnut/daemon.cjs' walnut \"$@\"\n");
    expect(gatewayShimScript(['/x/core'])).not.toContain(' wn ');
  });

  it('single-quotes every path (a quote or space in a path must not split the exec)', () => {
    expect(shimQuote("/tmp/it's here/core")).toBe("'/tmp/it'\\''s here/core'");
    const shim = gatewayShimScript(["/tmp/a b/it's/core"]);
    expect(shim).toContain("'/tmp/a b/it'\\''s/core'");
  });

  it('runs as real /bin/sh: execs the stable copy and forwards the keyword + args', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shim-core-'));
    try {
      const core = path.join(dir, SHIM_CORE_BASENAME);
      fs.writeFileSync(core, '#!/bin/sh\necho "CORE $*"\n', { mode: 0o755 });
      const shimPath = path.join(dir, 'walnut');
      fs.writeFileSync(shimPath, gatewayShimScript([core]), { mode: 0o755 });
      const res = spawnSync(shimPath, ['tools', 'list', '--json'], { encoding: 'utf-8' });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('CORE walnut tools list --json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shimCoreNeedsCopy', () => {
  const V = 'walnut-daemon-abc123456789';

  it('copies when there is no stable copy yet', () => {
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: null, stampedVersion: null, version: V })).toBe(true);
  });

  it('skips when size AND version stamp both match (the cheap boot path)', () => {
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: 60_000_000, stampedVersion: V, version: V })).toBe(false);
  });

  it('copies when the size differs, or the stamp is absent / stale', () => {
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: 59_999_999, stampedVersion: V, version: V })).toBe(true);
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: 60_000_000, stampedVersion: null, version: V })).toBe(true);
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: 60_000_000, stampedVersion: '', version: V })).toBe(true);
    expect(shimCoreNeedsCopy({ srcSize: 60_000_000, dstSize: 60_000_000, stampedVersion: 'walnut-daemon-old', version: V })).toBe(true);
  });

  it('never copies from an unusable source (caller then falls back to execPath)', () => {
    expect(shimCoreNeedsCopy({ srcSize: null, dstSize: null, stampedVersion: null, version: V })).toBe(false);
    expect(shimCoreNeedsCopy({ srcSize: 0, dstSize: null, stampedVersion: null, version: V })).toBe(false);
  });

  it("the node twin's hand-inlined copy makes the same decision on every case", () => {
    // The template cannot import, so it carries its own copy of the rule. Run
    // the template's OWN function text against the shared implementation.
    const start = templateSrc.indexOf('function shimCoreNeedsCopy(');
    expect(start).toBeGreaterThan(-1);
    const end = templateSrc.indexOf('\n}', start);
    const fnSrc = templateSrc.slice(start, end + 2);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const twin = new Function(fnSrc + '\nreturn shimCoreNeedsCopy;')() as (
      srcSize: number | null, dstSize: number | null, stamped: string | null, version: string,
    ) => boolean;
    const sizes: Array<number | null> = [null, 0, 10, 11];
    const stamps: Array<string | null> = [null, '', V, 'other'];
    for (const srcSize of sizes) {
      for (const dstSize of sizes) {
        for (const stampedVersion of stamps) {
          expect(twin(srcSize, dstSize, stampedVersion, V), `${srcSize}/${dstSize}/${stampedVersion}`)
            .toBe(shimCoreNeedsCopy({ srcSize, dstSize, stampedVersion, version: V }));
        }
      }
    }
  });
});

/**
 * Behavioural coverage for the node twin: its OWN writeWalnutShim text is
 * extracted and RUN with injected globals, so the two branches (artifact already
 * in the stable dir vs. artifact in a throwaway stage dir) are exercised, not
 * just pattern-matched. The bun twin cannot be imported from vitest (it needs the
 * `bun` runtime types), so its identical shape is pinned by text above.
 */
describe('node twin writeWalnutShim — real run', () => {
  function extractFn(name: string): string {
    const start = templateSrc.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return templateSrc.slice(start, templateSrc.indexOf('\n}', start) + 2);
  }

  /** The template's own three functions, wired to real fs + fake process/globals. */
  function makeWriteShim(opts: { shimDir: string; daemonDir: string; version: string; entry: string; execPath: string }) {
    const logs: Array<{ level: string; msg: string }> = [];
    const body = [
      extractFn('shimCoreNeedsCopy'),
      extractFn('ensureShimCoreCopy'),
      extractFn('reapShimCoreArtifacts'),
      extractFn('writeWalnutShim'),
    ]
      .join('\n')
      // Every backslash is DOUBLED inside the DAEMON_SOURCE template literal
      // (`\\n`, `'\\\\''`); the deployed daemon.cjs carries the single form, so
      // undo one level to get exactly the code that runs on a host.
      .replace(/\\\\/g, '\\');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function(
      'fs', 'path', 'process', 'GATEWAY_SHIM_DIR', 'DAEMON_DIR', 'DAEMON_VERSION',
      'logMsg', 'installUserWalnutShim',
      body + '\nreturn writeWalnutShim;',
    ) as (...args: unknown[]) => () => void;
    const run = make(
      fs, path,
      { argv: ['node', opts.entry], execPath: opts.execPath, pid: process.pid },
      opts.shimDir, opts.daemonDir, opts.version,
      (level: string, msg: string) => { logs.push({ level, msg }); },
      () => { /* user-PATH shim covered by walnut-user-shim.test.ts */ },
    );
    return { run, logs };
  }

  it('skips the copy when the launched script already lives in the stable daemon dir', () => {
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-stable-'));
    try {
      const shimDir = path.join(daemonDir, 'bin');
      const entry = path.join(daemonDir, 'daemon.cjs');
      fs.writeFileSync(entry, '// daemon\n');
      makeWriteShim({ shimDir, daemonDir, version: 'v1', entry, execPath: '/usr/bin/node' }).run();
      const shim = fs.readFileSync(path.join(shimDir, 'walnut'), 'utf-8');
      expect(shim).toBe(`#!/bin/sh\nexec '/usr/bin/node' '${entry}' walnut "$@"\n`);
      expect(fs.existsSync(path.join(shimDir, 'walnut-core.cjs'))).toBe(false);
    } finally {
      fs.rmSync(daemonDir, { recursive: true, force: true });
    }
  });

  it('reaps the debris the shim no longer names: a crash-left temp and an unreferenced copy', () => {
    // An already-deployed host wrote bin/walnut-core.cjs under the old
    // always-copy code, and its artifact lives in the daemon dir, so the no-copy
    // path now runs forever: without a sweep that ~60MB file plus its orphaned
    // .version stamp stay there for good. A `.tmp-<pid>` is what a SIGKILL
    // between copyFileSync and renameSync leaves behind, under a fresh name each
    // time. The shim itself, and a foreign file, must survive.
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-reap-'));
    try {
      const shimDir = path.join(daemonDir, 'bin');
      const entry = path.join(daemonDir, 'daemon.cjs');
      fs.writeFileSync(entry, '// daemon\n');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(path.join(shimDir, 'walnut-core.cjs'), 'stale copy');
      fs.writeFileSync(path.join(shimDir, 'walnut-core.cjs.version'), 'v0');
      fs.writeFileSync(path.join(shimDir, 'walnut-core.cjs.tmp-4242'), 'partial copy');
      fs.writeFileSync(path.join(shimDir, 'something-else'), 'not ours');

      makeWriteShim({ shimDir, daemonDir, version: 'v1', entry, execPath: '/usr/bin/node' }).run();

      expect(fs.readdirSync(shimDir).sort()).toEqual(['something-else', 'walnut']);
    } finally {
      fs.rmSync(daemonDir, { recursive: true, force: true });
    }
  });

  it('keeps the stable copy it still execs, stamp included', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-keep-'));
    try {
      const daemonDir = path.join(root, 'open-walnut');
      const shimDir = path.join(daemonDir, 'bin');
      const stage = path.join(root, 'stage', 'dist');
      fs.mkdirSync(stage, { recursive: true });
      const entry = path.join(stage, 'daemon.cjs');
      fs.writeFileSync(entry, '// staged daemon\n');
      makeWriteShim({ shimDir, daemonDir, version: 'v1', entry, execPath: '/usr/bin/node' }).run();
      // The sweep runs on this path too — it must not delete the copy the shim
      // it just wrote points at, nor the stamp that makes the next boot a stat.
      expect(fs.readdirSync(shimDir).sort())
        .toEqual(['walnut', 'walnut-core.cjs', 'walnut-core.cjs.version']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies to the stable dir when launched from a stage dir, and the shim survives that dir being deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-stage-'));
    try {
      const daemonDir = path.join(root, 'open-walnut');
      const shimDir = path.join(daemonDir, 'bin');
      const stage = path.join(root, 'open-walnut-stage.123', 'dist');
      fs.mkdirSync(stage, { recursive: true });
      const entry = path.join(stage, 'daemon.cjs');
      fs.writeFileSync(entry, '// staged daemon\n');
      // Stand-in for the runtime: the shim only execs it, so a script that echoes
      // its argv proves what the shim points at.
      const fakeNode = path.join(root, 'fake-node');
      fs.writeFileSync(fakeNode, '#!/bin/sh\necho "RUNTIME $*"\n', { mode: 0o755 });

      const { run, logs } = makeWriteShim({ shimDir, daemonDir, version: 'v1', entry, execPath: fakeNode });
      run();

      const core = path.join(shimDir, 'walnut-core.cjs');
      expect(fs.existsSync(core)).toBe(true);
      expect(fs.readFileSync(path.join(shimDir, 'walnut-core.cjs.version'), 'utf-8')).toBe('v1');
      expect(fs.readFileSync(path.join(shimDir, 'walnut'), 'utf-8'))
        .toBe(`#!/bin/sh\nexec '${fakeNode}' '${core}' walnut "$@"\n`);
      expect(logs.some((l) => l.level === 'info' && l.msg === 'walnut shim core copied')).toBe(true);
      // No leftover temp file from the atomic copy.
      expect(fs.readdirSync(shimDir).filter((f) => f.includes('.tmp-'))).toEqual([]);

      // THE BUG THIS FIXES: the next deploy deletes the stage dir. The shim must
      // still work — it points at the stable copy, not at the vanished artifact.
      fs.rmSync(path.join(root, 'open-walnut-stage.123'), { recursive: true, force: true });
      const res = spawnSync(path.join(shimDir, 'walnut'), ['tools', 'list'], { encoding: 'utf-8' });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(`RUNTIME ${core} walnut tools list`);

      // Second boot at the same version + size: no re-copy (cheap restart).
      const before = fs.statSync(core).mtimeMs;
      const again = makeWriteShim({ shimDir, daemonDir, version: 'v1', entry: core, execPath: fakeNode });
      again.run();
      expect(again.logs.some((l) => l.msg === 'walnut shim core copied')).toBe(false);
      expect(fs.statSync(core).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('writeWalnutShim (both twins)', () => {
  it('is named for the one CLI name and the old name is gone', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function writeWalnutShim\(\)/);
      expect(src).toMatch(/writeWalnutShim\(\);?\n/);
      expect(src).not.toMatch(/writeWnShim/);
    }
  });

  it('both twins sweep the shim dir AFTER the shim is rewritten, never before', () => {
    for (const [src, call] of [
      [standaloneSrc, 'reapShimCoreArtifacts(argv)'],
      [templateSrc, 'reapShimCoreArtifacts([target]);'],
    ] as const) {
      const start = src.indexOf('function writeWalnutShim()');
      const body = src.slice(start, src.indexOf('\n}', start));
      expect(body).toContain(call);
      // Order is the safety property: unlinking a copy the OLD shim still names
      // would break `walnut` in every live session until the sweep's own rewrite.
      expect(body.indexOf('chmodSync')).toBeLessThan(body.indexOf('reapShimCoreArtifacts'));
    }
  });

  it('the bun twin execs the STABLE copy for a compiled binary and the script in a dev run', () => {
    const start = standaloneSrc.indexOf('function writeWalnutShim()');
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start));
    // Dev run: real script on disk → runtime + script, current behavior.
    expect(body).toMatch(/\[process\.execPath, devScript\]/);
    // Compiled binary: the stable copy, with execPath only as a LAST resort — a
    // shim that works until the next deploy beats no shim at all.
    expect(body).toMatch(/\[ensureShimCoreCopy\(\) \?\? process\.execPath\]/);
    expect(body).toMatch(/gatewayShimScript\(argv\)/);
    // The old shape (exec the running binary, legacy keyword) must be gone.
    expect(body).not.toMatch(/' wn "\$@"'/);
    expect(standaloneSrc).not.toMatch(/shellQuote\(process\.execPath\) \+ script \+ ' wn/);
  });

  it('the node twin execs the stable copy of its script, and the shim carries the canonical keyword', () => {
    const start = templateSrc.indexOf('function writeWalnutShim()');
    const body = templateSrc.slice(start, templateSrc.indexOf('\n}', start));
    expect(body).toMatch(/target = entry \? \(ensureShimCoreCopy\(entry\) \|\| entry\) : entry;/);
    expect(body).toMatch(/' walnut "\$@"/);
    expect(body).not.toMatch(/' wn "\$@"/);
  });

  it('neither twin copies an artifact that already lives in the stable daemon dir', () => {
    // Every SSH-deployed host runs its artifact FROM the daemon dir, so paying a
    // hundreds-of-MB copy there would be pure waste on the startup path the
    // parent's port-file wait is timing.
    for (const [src, arg] of [[standaloneSrc, 'process.execPath'], [templateSrc, 'srcPath']] as const) {
      const start = src.indexOf('function ensureShimCoreCopy(');
      const body = src.slice(start, src.indexOf('\n}', start));
      expect(body).toMatch(
        new RegExp(`path\\.resolve\\(path\\.dirname\\(${arg.replace('.', '\\.')}\\)\\) === path\\.resolve\\(DAEMON_DIR\\)`),
      );
    }
  });

  it('both copy atomically (temp name in the SAME dir + rename) and stamp the version', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      const start = src.indexOf('function ensureShimCoreCopy(')
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n}', start));
      // Same-dir temp → rename: atomic, and never EXDEV across devices.
      expect(body).toMatch(/tmp = dst \+ '\.tmp-' \+ process\.pid/);
      // COPYFILE_FICLONE: a same-volume copy becomes a COW clone (fast, and the
      // clone survives the source being deleted, which is the whole point).
      expect(body).toMatch(/copyFileSync\((?:process\.execPath|srcPath), tmp, fs\.constants\.COPYFILE_FICLONE\)/);
      expect(body).toMatch(/renameSync\(tmp, dst\)/);
      // Stamp AFTER the rename, so a crash mid-copy re-copies next boot.
      expect(body.indexOf('renameSync(tmp, dst)')).toBeLessThan(body.indexOf('writeFileSync(stampPath'));
      // Failure is degraded, never fatal: warn + fall back to the running path.
      expect(body).toMatch(/logMsg\('warn', 'walnut shim core copy failed/);
      expect(body).toMatch(/return null;?\s*\n\s*\}/);
      // The partial temp file is never left behind.
      expect(body).toMatch(/unlinkSync\(tmp\)/);
    }
  });
});
