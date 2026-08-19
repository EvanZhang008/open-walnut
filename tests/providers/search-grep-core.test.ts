/**
 * Host-local symbol search ("find references" for the Files viewer).
 *
 * classifyDefinition is pure and tested directly. The search itself talks to
 * real git/grep on a real temp tree, because "does git grep report paths
 * relative to the repo root" is exactly the kind of thing a mock would get
 * wrong. Every test stays inside its own mkdtemp dir: no repo working tree, no
 * processes, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { classifyDefinition, grepReferencesHostLocal } =
  await import('../../src/providers/search-grep-core.js');

let tmp: string;

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

/** Init a repo at `dir`, with identity set LOCALLY (never a global config write). */
function initRepo(dir: string): void {
  const opts = { cwd: dir, stdio: 'ignore' as const };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', '--local', 'user.email', 't@e'], opts);
  execFileSync('git', ['config', '--local', 'user.name', 'T'], opts);
  execFileSync('git', ['config', '--local', 'commit.gpgsign', 'false'], opts);
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-qm', 'init'], opts);
}

beforeEach(async () => {
  // realpath: macOS /var → /private/var, and git reports the real toplevel.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-grep-')));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('classifyDefinition', () => {
  it('treats a Go method with a receiver as a definition', () => {
    expect(classifyDefinition(
      'func (f *Factory) HasSyncedForGVRs(gate []string) bool {', 'HasSyncedForGVRs',
    )).toBe(true);
  });

  it('does NOT treat a closure that merely contains "func" as a definition', () => {
    // The line has both `func` and the symbol, but the symbol is a CALL. A
    // keyword rule that is not anchored to the symbol gets this wrong.
    expect(classifyDefinition(
      'syncedFn = func() bool { return c.informerFactory.HasSyncedForGVRs(gateGVRs) }',
      'HasSyncedForGVRs',
    )).toBe(false);
  });

  it('treats a TS const binding as a definition', () => {
    expect(classifyDefinition("const gateGVRs = ['a', 'b']", 'gateGVRs')).toBe(true);
  });

  it('treats a Go short declaration as a definition', () => {
    expect(classifyDefinition('gateGVRs := customGVRs', 'gateGVRs')).toBe(true);
  });

  it('treats a plain call as a reference', () => {
    expect(classifyDefinition('  foo(gateGVRs)', 'gateGVRs')).toBe(false);
  });

  it('treats an equality comparison as a reference, not an assignment', () => {
    expect(classifyDefinition('  gateGVRs == other', 'gateGVRs')).toBe(false);
  });

  it('treats a Java/C# style method as a definition', () => {
    expect(classifyDefinition(
      '  public static List<String> gateNames(String prefix) {', 'gateNames',
    )).toBe(true);
  });

  it('treats a TS class as a definition', () => {
    expect(classifyDefinition('export class LedgerClient {', 'LedgerClient')).toBe(true);
  });
});

describe('input guards', () => {
  it('rejects a symbol that is not an identifier', async () => {
    const res = await grepReferencesHostLocal({ file: path.join(tmp, 'a.ts'), symbol: 'a b' });
    expect(res).toMatchObject({ tool: 'none', error: 'invalid symbol', matches: [], root: '' });
  });

  it('rejects a symbol carrying shell metacharacters', async () => {
    const res = await grepReferencesHostLocal({ file: path.join(tmp, 'a.ts'), symbol: '$(id)' });
    expect(res.error).toBe('invalid symbol');
  });

  it('rejects a relative file path', async () => {
    const res = await grepReferencesHostLocal({ file: 'src/a.ts', symbol: 'foo' });
    expect(res).toMatchObject({ tool: 'none', error: 'file must be absolute' });
  });
});

describe('git grep (repo)', () => {
  /** One def + two refs across two files, committed. Returns the entry file. */
  async function buildRepo(): Promise<string> {
    const repo = path.join(tmp, 'repo');
    const target = await writeFile('repo/pkg/factory.go', [
      'package pkg',
      '',
      'func (f *Factory) HasSyncedForGVRs(gate []string) bool {',
      '\treturn true',
      '}',
    ].join('\n') + '\n');
    await writeFile('repo/cmd/main.go', [
      'package main',
      '',
      'func run() {',
      '\t_ = factory.HasSyncedForGVRs(nil)',
      '}',
    ].join('\n') + '\n');
    await writeFile('repo/cmd/check.go', [
      'package main',
      '',
      'var ok = factory.HasSyncedForGVRs(gateGVRs)',
    ].join('\n') + '\n');
    initRepo(repo);
    return target;
  }

  it('finds the definition and both refs, definition first, absolute paths', async () => {
    const target = await buildRepo();
    const res = await grepReferencesHostLocal({ file: target, symbol: 'HasSyncedForGVRs' });

    expect(res.tool).toBe('git-grep');
    expect(res.root).toBe(path.join(tmp, 'repo'));
    expect(res.truncated).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.matches).toHaveLength(3);
    // Definition sorted first.
    expect(res.matches[0]).toMatchObject({
      file: target, line: 3, kind: 'def',
    });
    expect(res.matches[0]!.text).toContain('func (f *Factory) HasSyncedForGVRs');
    // Then refs by file path, then line. Every path absolute.
    expect(res.matches.slice(1).map((m) => [m.file, m.line, m.kind])).toEqual([
      [path.join(tmp, 'repo/cmd/check.go'), 3, 'ref'],
      [path.join(tmp, 'repo/cmd/main.go'), 4, 'ref'],
    ]);
    for (const m of res.matches) expect(path.isAbsolute(m.file)).toBe(true);
  });

  it('caps at maxMatches and reports truncated', async () => {
    const target = await buildRepo();
    const res = await grepReferencesHostLocal({
      file: target, symbol: 'HasSyncedForGVRs', maxMatches: 1,
    });
    expect(res.tool).toBe('git-grep');
    expect(res.matches).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it('matches whole words only', async () => {
    const repo = path.join(tmp, 'repo2');
    const target = await writeFile('repo2/a.ts', [
      'const gate = 1',
      'const gateGVRs = 2',
      'export { gate }',
    ].join('\n') + '\n');
    initRepo(repo);
    const res = await grepReferencesHostLocal({ file: target, symbol: 'gate' });
    expect(res.matches.map((m) => m.line)).toEqual([1, 3]);
  });

  it('returns zero matches (not an error) when the symbol is absent', async () => {
    const repo = path.join(tmp, 'repo3');
    const target = await writeFile('repo3/a.ts', 'const x = 1\n');
    initRepo(repo);
    const res = await grepReferencesHostLocal({ file: target, symbol: 'nowhere' });
    expect(res).toMatchObject({ tool: 'git-grep', matches: [], truncated: false });
    expect(res.error).toBeUndefined();
  });
});

describe('grep fallback (no repo)', () => {
  it('searches a plain directory and returns absolute paths', async () => {
    const target = await writeFile('plain/lib.ts', [
      'export const marinaId = 7',
      'console.log(marinaId)',
    ].join('\n') + '\n');
    await writeFile('plain/other.ts', 'import { marinaId } from "./lib"\n');

    const res = await grepReferencesHostLocal({ file: target, symbol: 'marinaId' });
    expect(res.tool).toBe('grep');
    expect(res.root).toBe(path.join(tmp, 'plain'));
    expect(res.matches.length).toBeGreaterThanOrEqual(3);
    for (const m of res.matches) expect(path.isAbsolute(m.file)).toBe(true);
    // The `export const` line is the definition and sorts first.
    expect(res.matches[0]).toMatchObject({ file: target, line: 1, kind: 'def' });
  });

  it('never returns a hit from inside a pruned directory', async () => {
    const target = await writeFile('plain2/lib.ts', 'export const marinaId = 7\n');
    await writeFile('plain2/node_modules/dep/index.js', 'exports.marinaId = 1\n');
    const res = await grepReferencesHostLocal({ file: target, symbol: 'marinaId' });
    expect(res.tool).toBe('grep');
    expect(res.matches.some((m) => m.file.includes('node_modules'))).toBe(false);
  });

  // A FIFO in the tree makes a plain `grep -r` BLOCK on the open until the
  // timeout kills it: whole budget burnt, zero results. Walnut's own session
  // pipes live in directories like this, so the skip flag is load-bearing.
  // (The FIFO is created inside the per-test tmpdir and nothing reads or writes
  // it — no signals, no processes touched.)
  it('skips a FIFO instead of blocking on it', async () => {
    const target = await writeFile('fifo/lib.ts', 'export const marinaId = 7\n');
    execFileSync('mkfifo', [path.join(tmp, 'fifo', 'stream.pipe')], { stdio: 'ignore' });
    const started = Date.now();
    const res = await grepReferencesHostLocal({ file: target, symbol: 'marinaId' });
    const elapsed = Date.now() - started;
    expect(res.tool).toBe('grep');
    expect(res.error).toBeUndefined();
    expect(res.matches[0]).toMatchObject({ file: target, line: 1, kind: 'def' });
    // Well under the 8s grep timeout — proof it never opened the pipe.
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('caps', () => {
  it('truncates a very long match line', async () => {
    const target = await writeFile('plain3/min.js', 'var marinaId=1;' + 'x'.repeat(2000) + '\n');
    const res = await grepReferencesHostLocal({ file: target, symbol: 'marinaId' });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.text.length).toBe(300);
  });
});
