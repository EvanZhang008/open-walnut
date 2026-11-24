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

  it('the daemon routes BOTH keywords into the CLI, never into the usage error', () => {
    // The shared predicate, imported.
    expect(standaloneSrc).toMatch(/if \(isDaemonCliKeyword\(action\)\) \{/);
    expect(standaloneSrc).toMatch(/const \{ runWalnutCli \} = await import\('\.\/wn-cli\.js'\)/);
    expect(standaloneSrc).not.toMatch(/if \(action === 'wn'\)/);
    // Dispatched before the daemon runtime is created: a CLI sets no daemon up (2026-11-24 drill).
    expect(standaloneSrc.indexOf('if (isDaemonCliKeyword(action)) {')).toBeLessThan(standaloneSrc.indexOf('runtime = await createDaemonRuntime({'));
  });

  it('the daemon keeps CLI argv out of the --version fast path for both keywords', () => {
    // `walnut tools call session_send '{"text":"… --version …"}'` must not print
    // the daemon version and exit 0.
    // In its process entry (runDaemonProcess): argv is process.argv, action is argv[2].
    expect(standaloneSrc).toMatch(/const action = argv\[2\]/);
    expect(standaloneSrc).toMatch(
      /if \(argv\.includes\('--version'\) && !isDaemonCliKeyword\(action\)\) \{/,
    );
  });

  it('the usage lines advertise the canonical keyword', () => {
    expect(standaloneSrc).toMatch(/--version \| walnut <args\.\.\.>/);
    expect(standaloneSrc).not.toMatch(/--version \| wn <args\.\.\.>/);
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

});

describe('writeWalnutShim', () => {
  it('is named for the one CLI name and the old name is gone', () => {
    expect(standaloneSrc).toMatch(/function writeWalnutShim\(\)/);
    expect(standaloneSrc).toMatch(/writeWalnutShim\(\);?\n/);
    expect(standaloneSrc).not.toMatch(/writeWnShim/);
  });

  it('sweeps the shim dir AFTER the shim is rewritten, never before', () => {
    const start = standaloneSrc.indexOf('function writeWalnutShim()');
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start));
    expect(body).toContain('reapShimCoreArtifacts(argv)');
    // Order is the safety property: unlinking a copy the OLD shim still names
    // would break `walnut` in every live session until the sweep's own rewrite.
    expect(body.indexOf('chmodSync')).toBeLessThan(body.indexOf('reapShimCoreArtifacts'));
  });

  it('execs the STABLE copy for a compiled binary and the script in a dev run', () => {
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

  it('never copies an artifact that already lives in the stable daemon dir', () => {
    // Every SSH-deployed host runs its artifact FROM the daemon dir, so paying a
    // hundreds-of-MB copy there would be pure waste on the startup path the
    // parent's port-file wait is timing.
    const start = standaloneSrc.indexOf('function ensureShimCoreCopy(');
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start));
    expect(body).toMatch(/path\.resolve\(path\.dirname\(process\.execPath\)\) === path\.resolve\(DAEMON_DIR\)/);
  });

  it('copies atomically (temp name in the SAME dir + rename) and stamps the version', () => {
    const start = standaloneSrc.indexOf('function ensureShimCoreCopy(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start));
    // Same-dir temp → rename: atomic, and never EXDEV across devices.
    expect(body).toMatch(/tmp = dst \+ '\.tmp-' \+ process\.pid/);
    // COPYFILE_FICLONE: a same-volume copy becomes a COW clone (fast, and the
    // clone survives the source being deleted, which is the whole point).
    expect(body).toMatch(/copyFileSync\(process\.execPath, tmp, fs\.constants\.COPYFILE_FICLONE\)/);
    expect(body).toMatch(/renameSync\(tmp, dst\)/);
    // Stamp AFTER the rename, so a crash mid-copy re-copies next boot.
    expect(body.indexOf('renameSync(tmp, dst)')).toBeLessThan(body.indexOf('writeFileSync(stampPath'));
    // Failure is degraded, never fatal: warn + fall back to the running path.
    expect(body).toMatch(/logMsg\('warn', 'walnut shim core copy failed/);
    expect(body).toMatch(/return null;?\s*\n\s*\}/);
    // The partial temp file is never left behind.
    expect(body).toMatch(/unlinkSync\(tmp\)/);
  });
});
