/**
 * A workflow that downloads an installer and runs it retries the whole install, never only the
 * download (2026-11-09: Windows join failed on one GitHub 504 inside bun's installer, which
 * fetches bun itself where curl's --retry does not reach). And it never pipes the download into a
 * shell: a pipe into bash runs nothing, and succeeds, when the download fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const workflows = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
const PIPED = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;

/** The bun install loop of windows-join.yml, as its step runs it. */
function bunLoop(): string {
  const lines = fs.readFileSync(path.join(WORKFLOWS, 'windows-join.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*for i in 1 2 3; do$/.test(l) && lines.slice(lines.indexOf(l)).some((n) => n.includes('bun.sh/install')));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^\s*done$/.test(l));
  return lines.slice(start, end + 1).map((l) => l.trim()).join('\n');
}

/** Runs the loop with stand-ins for curl, bash's installer and sleep; returns attempts and exit. */
function runLoop(installerFailures: number, downloadFailures = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-retry-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const count = (name: string) => `n=$(cat "${dir}/${name}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/${name}"`;
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n${count('downloads')}\n[ "$n" -le ${downloadFailures} ] && exit 22\nwhile [ "$1" != "-o" ]; do shift; done\nprintf '%s\\n' '${count('installs')}' '[ "$n" -le ${installerFailures} ] && exit 1' 'exit 0' > "$2"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = `set -eu\ntmp="${dir}"\n${bunLoop()}\necho finished`;
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    const read = (n: string) => Number(fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8').trim() : 0);
    return { status: r.status, finished: r.stdout.includes('finished'), downloads: read('downloads'), installs: read('installs') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('workflow installers', () => {
  it('no workflow pipes a download into a shell', () => {
    expect(workflows.length).toBeGreaterThan(5);
    const piped = workflows.flatMap((f) => fs.readFileSync(path.join(WORKFLOWS, f), 'utf8').split('\n')
      .map((l, i) => (PIPED.test(l) && !/^\s*#/.test(l) ? `${f}:${i + 1}` : '')).filter(Boolean));
    expect(piped).toEqual([]);
  });

  it('every bun.sh installer download sits in a loop that retries the whole install', () => {
    const sites = workflows.flatMap((f) => fs.readFileSync(path.join(WORKFLOWS, f), 'utf8').split('\n')
      .map((l, i, all) => ({ f, i, l, all })).filter(({ l }) => l.includes('https://bun.sh/install') && !/^\s*#/.test(l)));
    expect(sites.length).toBeGreaterThan(0);
    for (const { f, i, all } of sites) {
      const before = all.slice(Math.max(0, i - 3), i).join('\n');
      const after = all.slice(i, i + 3).join('\n');
      expect(before, `${f}:${i + 1}`).toMatch(/for i in 1 2 3; do/);
      expect(after, `${f}:${i + 1}`).toMatch(/&& break/);
    }
  });

  it('an installer that fails twice is run a third time, and the step goes on', () => {
    expect(runLoop(2)).toEqual({ status: 0, finished: true, downloads: 3, installs: 3 });
  });

  it('a download that fails is fetched again, never run empty', () => {
    expect(runLoop(0, 1)).toEqual({ status: 0, finished: true, downloads: 2, installs: 1 });
  });

  it('three failed installs fail the step', () => {
    const r = runLoop(3);
    expect(r.status).not.toBe(0);
    expect(r.finished).toBe(false);
    expect(r.installs).toBe(3);
  });

  it('one good install runs once', () => {
    expect(runLoop(0)).toEqual({ status: 0, finished: true, downloads: 1, installs: 1 });
  });
});
