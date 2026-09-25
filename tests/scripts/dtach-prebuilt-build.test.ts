import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { afterAll, describe, expect, it } from 'vitest';

// The npm package ships a prebuilt dtach so a Mac without the Command Line Tools
// still gets a persistent terminal (src/web/terminal/dtach-prebuilt.ts). These pin
// the build step that makes it, the rule that it never fails a build, and the
// tarball wiring that ships it next to the big daemon binaries it must not drag in.

const root = path.resolve(__dirname, '../..');
const BUILD_DAEMON = path.join(root, 'scripts/build-daemon.sh');
const BUILD_DTACH = path.join(root, 'scripts/build-dtach.sh');
const read = (p: string) => fs.readFileSync(p, 'utf8');

const tmpRoots: string[] = [];
afterAll(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** A PATH holding only what build-dtach.sh needs besides a compiler. */
function toolsWithoutCompiler(): string {
  const bin = tmp('dtach-nocc-bin-');
  for (const tool of ['uname', 'shasum', 'sha256sum', 'perl', 'cut', 'cat', 'mktemp', 'cp', 'mkdir', 'rm', 'grep', 'printf', 'dirname', 'tr', 'wc', 'tail']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

const ccWorks = ['cc', 'clang', 'gcc'].some((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
const hostName = (() => {
  const p = ({ darwin: 'darwin', linux: 'linux' } as Record<string, string>)[process.platform];
  const a = ({ arm64: 'arm64', x64: 'x64' } as Record<string, string>)[process.arch];
  return p && a ? `dtach-${p}-${a}` : null;
})();

describe('build-daemon.sh: the dtach step', () => {
  const src = read(BUILD_DAEMON);

  it('runs build-dtach.sh into the binaries dir and survives its failure', () => {
    expect(src).toMatch(/bash scripts\/build-dtach\.sh "\$OUTDIR" \\\n\s+\|\| echo "build-daemon\.sh: the prebuilt dtach step failed; continuing/);
  });

  it('runs after the no-Bun early exit, so that path still writes nothing to dist/', () => {
    expect(src.indexOf('scripts/build-dtach.sh "$OUTDIR"')).toBeGreaterThan(src.indexOf('skipping the daemon binaries'));
  });

  it('lists the dtach files without failing when none were built', () => {
    expect(src).toContain('ls -lh "$OUTDIR"/dtach-* 2>/dev/null || true');
  });
});

describe('build-dtach.sh', () => {
  const src = read(BUILD_DTACH);

  it('skips with one info line and exit 0 when there is no compiler', () => {
    expect(src).toMatch(/no C compiler on this machine, skipping the prebuilt dtach[^\n]*"\n\s+exit 0/);
    const out = tmp('dtach-nocc-out-');
    const r = spawnSync('/bin/bash', [BUILD_DTACH, out], { env: { PATH: toolsWithoutCompiler(), HOME: tmp('dtach-home-') }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no C compiler on this machine, skipping the prebuilt dtach/);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('never writes a `.version` sidecar (the daemon version check reads every one)', () => {
    expect(src).toContain('.source-hash');
    expect(src).not.toMatch(/\$name\.version|dtach-[^"\s]*\.version/);
  });

  it('prints a stable 64-hex source hash', () => {
    const a = spawnSync('bash', [BUILD_DTACH, '--print-hash'], { encoding: 'utf8' });
    const b = spawnSync('bash', [BUILD_DTACH, '--print-hash'], { encoding: 'utf8' });
    expect(a.status).toBe(0);
    expect(a.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(b.stdout).toBe(a.stdout);
  });

  it.skipIf(!ccWorks || !hostName)('builds a stripped dtach for this machine that answers --help, with its source hash', () => {
    const out = tmp('dtach-build-out-');
    const r = spawnSync('bash', [BUILD_DTACH, out], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status).toBe(0);
    const bin = path.join(out, hostName!);
    const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
    expect(help.stdout + help.stderr).toMatch(/dtach - version 0\.9/);
    const hash = spawnSync('bash', [BUILD_DTACH, '--print-hash'], { encoding: 'utf8' }).stdout.trim();
    expect(read(`${bin}.source-hash`).trim()).toBe(hash);
    expect(fs.statSync(bin).size).toBeLessThan(2 * 1024 * 1024);
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.version'))).toEqual([]);
    if (process.platform === 'darwin') {
      // Both Mac arches from one Mac, so an Intel Mac needs no compiler either.
      expect(fs.existsSync(path.join(out, 'dtach-darwin-arm64'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'dtach-darwin-x64'))).toBe(true);
    }
  });
});

describe('tarball wiring', () => {
  const pkg = JSON.parse(read(path.join(root, 'package.json'))) as { files: string[]; scripts: Record<string, string> };

  it('ships dtach-* while the big daemon binaries stay out', () => {
    expect(pkg.files).toContain('dist/daemon-binaries/dtach-*');
    const negations = pkg.files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));
    const excluded = (p: string) => negations.some((n) => minimatch(p, n));
    for (const f of ['dtach-darwin-arm64', 'dtach-darwin-arm64.source-hash', 'dtach-darwin-x64', 'dtach-linux-x64']) {
      expect(excluded(`dist/daemon-binaries/${f}`), f).toBe(false);
    }
    for (const f of ['daemon-darwin-arm64', 'daemon-linux-x64', 'daemon-linux-arm64.version']) {
      expect(excluded(`dist/daemon-binaries/${f}`), f).toBe(true);
    }
  });

  it('check-publish requires the host prebuilt where a compiler works and checks it is packed and fresh', () => {
    const gate = read(path.join(root, 'scripts/check-publish.mjs'));
    expect(pkg.scripts.prepublishOnly).toContain('node scripts/check-publish.mjs');
    expect(gate).toMatch(/if \(hostDtach && compilerWorks\(\)\) \{\n\s+required\.push\(`dist\/daemon-binaries\/\$\{hostDtach\}`/);
    expect(gate).toContain("'--print-hash'");
    expect(gate).toMatch(/\.\.\.dtachFiles\.flatMap/); // every built dtach must be in the pack list
  });
});
