/**
 * The compacted chain is written in a fixed number of git calls (2026-11-25:
 * one `commit-tree` per kept commit took 30+ minutes on the real data repo and
 * deploys cut those runs short). The objects must be exactly what
 * `git commit-tree` would have written.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildCompactedChain, rawGitDate } from '../../src/integrations/git-compaction-chain.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-chain-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'T Tester']);
  // Subjects that a shell would mangle, and a non-ASCII one.
  const subjects = ['plain', 'quote " and $HOME and `tick`', 'café 中文', ''];
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `v${i}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '--allow-empty-message', '-m', s], {
      GIT_AUTHOR_DATE: `2026-0${i + 1}-15T10:00:00-0${i}:30`, GIT_COMMITTER_DATE: `2026-0${i + 1}-15T10:00:00-0${i}:30`,
    });
  });
  return dir;
}

function logOf(dir: string): Array<{ hash: string; date: string; message: string }> {
  return git(dir, ['log', '--reverse', '--format=%H %aI %s', 'main']).split('\n').map((line) => {
    const a = line.indexOf(' ');
    const found = line.indexOf(' ', a + 1);
    const b = found < 0 ? line.length : found;
    return { hash: line.slice(0, a), date: line.slice(a + 1, b), message: line.slice(b + 1) };
  });
}

describe('buildCompactedChain', () => {
  it('writes the same objects git commit-tree would', async () => {
    const dir = repo();
    const kept = logOf(dir);
    let parent = '';
    for (const c of kept) {
      parent = git(dir, ['commit-tree', `${c.hash}^{tree}`, ...(parent ? ['-p', parent] : []), '-m', c.message], {
        GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date,
      });
    }
    expect(await buildCompactedChain(dir, kept)).toBe(parent);
    expect(git(dir, ['rev-parse', `${parent}^{tree}`])).toBe(git(dir, ['rev-parse', 'main^{tree}']));
  });

  it('keeps every subject byte for byte, quotes and dollars included', async () => {
    const dir = repo();
    const kept = logOf(dir);
    const head = await buildCompactedChain(dir, kept);
    expect(git(dir, ['log', '--reverse', '--format=%s|', head]).split('\n').map((l) => l.slice(0, -1))).toEqual(kept.map((c) => c.message));
  });

  it('reads git dates with any offset', () => {
    expect(rawGitDate('2026-11-25T05:33:00-08:00')).toBe('1795613580 -0800');
    expect(rawGitDate('2026-11-25T13:33:00Z')).toBe('1795613580 +0000');
    expect(rawGitDate('2026-11-25T19:03:00+05:30')).toBe('1795613580 +0530');
  });
});

describe('class guard: compaction spawns no git process per kept commit', () => {
  it('no compaction source calls commit-tree', () => {
    const dir = path.resolve(__dirname, '../../src/integrations');
    const hits = fs.readdirSync(dir).filter((f) => /^git-compaction.*\.ts$/.test(f)).filter((f) => {
      const code = fs.readFileSync(path.join(dir, f), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return /commit-tree/.test(code);
    });
    expect(hits).toEqual([]);
  });
});
