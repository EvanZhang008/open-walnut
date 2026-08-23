/**
 * Conflict-marker detection + last-valid-version recovery.
 *
 * Incident being pinned (2026-08-22): a rescue path left git conflict markers
 * inside `config/share/ui-prefs.json` (nested markers, diff3 `|||||||` style)
 * and a conversation file; the 30s auto-save committed that marker text as the
 * files' real content, and every later read threw `Failed to parse …` — hours
 * of 500s on one route plus six crashes of a bus subscriber.
 *
 * Split on purpose: the detection/selection logic is pure and tested without
 * git, then ONE real temp repo proves the end-to-end restore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  scanForConflictMarkers,
  isParsableJson,
  firstParsableCandidate,
  jsonCandidatesFromPorcelain,
  unquotePorcelainPath,
  readFileBounded,
  findRepoRootUpward,
  findLastValidJsonVersion,
  healJsonFileFromHistory,
  sidecarPath,
  isInsideWalnutDataDir,
  MARKER_SCAN_BYTES,
} from '../../src/utils/json-conflict-recovery.js';

/** The real shape of the incident file: nested + diff3 markers. */
const NESTED_DIFF3 = [
  '{',
  '  "panelWidth": 320,',
  '<<<<<<< HEAD',
  '  "theme": "dark",',
  '<<<<<<< HEAD',
  '  "lastViewed": "a",',
  '||||||| merged common ancestors',
  '  "lastViewed": "base",',
  '=======',
  '  "lastViewed": "b",',
  '>>>>>>> origin/main',
  '=======',
  '  "theme": "light",',
  '>>>>>>> origin/main',
  '}',
].join('\n');

describe('scanForConflictMarkers', () => {
  it('flags the nested diff3 marker shape from the incident', () => {
    const scan = scanForConflictMarkers(NESTED_DIFF3);
    expect(scan.begin).toBe(true);
    expect(scan.end).toBe(true);
    expect(scan.conflicted).toBe(true);
  });

  it('flags a marker block whose closer is missing but whose JSON is broken', () => {
    const text = '{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2\n';
    const scan = scanForConflictMarkers(text);
    expect(scan.end).toBe(false);
    expect(scan.unparsable).toBe(true);
    expect(scan.conflicted).toBe(true);
  });

  it('does NOT flag clean JSON', () => {
    expect(scanForConflictMarkers('{"a":1}').conflicted).toBe(false);
  });

  it('does NOT flag a lone ======= line (far too common to act on)', () => {
    const text = '{"note":"a"}\n=======\n';
    expect(scanForConflictMarkers(text).conflicted).toBe(false);
  });

  it('does NOT flag marker text that appears INSIDE a JSON string value', () => {
    // A JSON string cannot hold a raw newline, so a real marker is always at
    // column 0 — which is why the scan anchors there.
    const text = JSON.stringify({ diff: '<<<<<<< HEAD\nx\n>>>>>>> other' }, null, 2);
    expect(isParsableJson(text)).toBe(true);
    expect(scanForConflictMarkers(text).conflicted).toBe(false);
  });

  it('does NOT flag on truncation alone: a bounded prefix never parses', () => {
    // Prefix of a large valid file: no markers at all → clean, truncated or not.
    const prefix = '{\n  "a": 1,\n  "b": 2';
    expect(scanForConflictMarkers(prefix, true).conflicted).toBe(false);
    // With a marker but no closer inside the window, truncation suppresses the
    // parse-based corroboration (the prefix would never parse anyway).
    expect(scanForConflictMarkers('{\n<<<<<<< HEAD\n  "a": 1', true).conflicted).toBe(false);
  });
});

describe('firstParsableCandidate', () => {
  it('returns the newest candidate that parses, skipping missing and broken ones', () => {
    const hit = firstParsableCandidate([
      { rev: 'HEAD', content: NESTED_DIFF3 },
      { rev: 'sha1', content: null },
      { rev: 'sha2', content: '   ' },
      { rev: 'sha3', content: '{"good":true}' },
      { rev: 'sha4', content: '{"older":true}' },
    ]);
    expect(hit).toEqual({ rev: 'sha3', content: '{"good":true}' });
  });

  it('returns null when nothing parses', () => {
    expect(firstParsableCandidate([{ rev: 'HEAD', content: '<<<<<<< HEAD' }])).toBeNull();
  });
});

describe('jsonCandidatesFromPorcelain', () => {
  it('keeps only .json paths and de-duplicates', () => {
    const out = jsonCandidatesFromPorcelain([
      ' M config/share/ui-prefs.json',
      '?? conversations/general/conv-1.json',
      ' M notes/diary.md',
      'UU tasks/tasks.json',
      ' M config/share/ui-prefs.json',
      '?? memory/',
    ]);
    expect(out).toEqual([
      'config/share/ui-prefs.json',
      'conversations/general/conv-1.json',
      'tasks/tasks.json',
    ]);
  });

  it('takes the NEW path of a rename (the only one that exists on disk)', () => {
    expect(jsonCandidatesFromPorcelain(['R  old/a.json -> new/b.json'])).toEqual(['new/b.json']);
  });

  it('decodes git-quoted paths and drops undecodable ones', () => {
    expect(jsonCandidatesFromPorcelain(['?? "conversations/caf\\303\\251.json"']))
      .toEqual(['conversations/café.json']);
    expect(jsonCandidatesFromPorcelain(['?? "broken\\q.json"'])).toEqual([]);
  });

  it('ignores short/blank lines', () => {
    expect(jsonCandidatesFromPorcelain(['', ' M ', 'M'])).toEqual([]);
  });

  it('survives the trimmed FIRST line that gitSafeAsync hands over', () => {
    // gitSafeAsync().trim() eats the leading space of the first porcelain line
    // whenever the index is clean, so ` M a.json` arrives as `M a.json`. A
    // positional slice(3) turned that into `.json`-suffixed garbage and the
    // guard scanned nothing — the bug this case exists to keep dead.
    expect(jsonCandidatesFromPorcelain(['M config/share/ui-prefs.json', ' M tasks/tasks.json']))
      .toEqual(['config/share/ui-prefs.json', 'tasks/tasks.json']);
    expect(jsonCandidatesFromPorcelain(['D gone.json'])).toEqual(['gone.json']);
  });

  it('keeps a path whose own name starts with a status letter and a space', () => {
    expect(jsonCandidatesFromPorcelain([' M M a.json'])).toEqual(['M a.json']);
    expect(jsonCandidatesFromPorcelain(['M M a.json'])).toEqual(['M a.json']);
  });
});

describe('unquotePorcelainPath', () => {
  it('passes unquoted paths through untouched', () => {
    expect(unquotePorcelainPath('a/b.json')).toBe('a/b.json');
  });
  it('handles escaped quotes and backslashes', () => {
    expect(unquotePorcelainPath('"a\\"b\\\\c.json"')).toBe('a"b\\c.json');
  });
  it('rejects an unterminated quote', () => {
    expect(unquotePorcelainPath('"a/b.json')).toBeNull();
  });
});

describe('isInsideWalnutDataDir', () => {
  const original = process.env.OPEN_WALNUT_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.OPEN_WALNUT_HOME;
    else process.env.OPEN_WALNUT_HOME = original;
  });

  it('gates on the data dir, resolved from the env var at call time', () => {
    const dir = path.join(os.tmpdir(), 'walnut-datadir-gate-test');
    process.env.OPEN_WALNUT_HOME = dir;
    expect(isInsideWalnutDataDir(path.join(dir, 'config', 'share', 'ui-prefs.json'))).toBe(true);
    expect(isInsideWalnutDataDir(dir)).toBe(true);
    expect(isInsideWalnutDataDir(path.join(os.tmpdir(), 'somewhere-else', 'x.json'))).toBe(false);
    // A sibling with the data dir as a string PREFIX must not pass the gate.
    expect(isInsideWalnutDataDir(`${dir}-other/x.json`)).toBe(false);
  });
});

describe('readFileBounded', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-readbounded-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reads a small file whole and reports it untruncated', async () => {
    const f = path.join(dir, 'a.json');
    await fsp.writeFile(f, '{"a":1}');
    expect(await readFileBounded(f)).toEqual({ text: '{"a":1}', truncated: false });
  });

  it('caps the read at the scan bound and flags truncation', async () => {
    const f = path.join(dir, 'big.json');
    await fsp.writeFile(f, 'x'.repeat(MARKER_SCAN_BYTES + 1024));
    const read = await readFileBounded(f);
    expect(read?.truncated).toBe(true);
    expect(read?.text.length).toBe(MARKER_SCAN_BYTES);
  });

  it('returns null for a missing path and for a directory', async () => {
    expect(await readFileBounded(path.join(dir, 'nope.json'))).toBeNull();
    expect(await readFileBounded(dir)).toBeNull();
  });
});

describe('sidecarPath', () => {
  it('parks beside the original (same dir → rename can never hit EXDEV)', () => {
    const p = sidecarPath('/data/config/share/ui-prefs.json', 'conflicted');
    expect(path.dirname(p)).toBe('/data/config/share');
    expect(p).toMatch(/ui-prefs\.json\.conflicted-\d{4}-\d{2}-\d{2}T/);
  });
});

// ── One real git repo: history walk + restore end to end ────────────────────

describe('recovery against a real git repo', () => {
  let repo: string;
  const run = (cmd: string, cwd: string): string =>
    execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();

  beforeEach(async () => {
    repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-jsonheal-repo-'));
    run('git init -q -b main', repo);
    run('git config user.email t@t && git config user.name t', repo);
  });
  afterEach(async () => {
    await fsp.rm(repo, { recursive: true, force: true });
  });

  it('finds the last valid version even when HEAD itself holds the marker text', async () => {
    const rel = 'config/share/ui-prefs.json';
    const file = path.join(repo, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });

    await fsp.writeFile(file, JSON.stringify({ theme: 'dark', v: 1 }, null, 2));
    run('git add -A && git commit -q -m good', repo);
    // The incident: marker text COMMITTED as the file's content.
    await fsp.writeFile(file, NESTED_DIFF3);
    run('git add -A && git commit -q -m bad', repo);

    const found = await findLastValidJsonVersion(repo, rel);
    expect(found).not.toBeNull();
    expect(JSON.parse(found!.content)).toEqual({ theme: 'dark', v: 1 });
    expect(found!.rev).not.toBe('HEAD');
  });

  it('restores the working file, parks the damaged original, and never invents data', async () => {
    const rel = 'tasks/store.json';
    const file = path.join(repo, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ tasks: ['keep'] }));
    run('git add -A && git commit -q -m good', repo);
    await fsp.writeFile(file, NESTED_DIFF3);

    const result = await healJsonFileFromHistory({ repoDir: repo, filePath: file, relPath: rel, label: 'conflicted' });
    expect(result.action).toBe('restored');
    expect(result.restoredFrom).toBe('HEAD');
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({ tasks: ['keep'] });
    // Forensics: the damaged original is still on disk under the sidecar name.
    expect(await fsp.readFile(result.movedTo!, 'utf-8')).toBe(NESTED_DIFF3);
  });

  it('quarantines when NO version in history parses (never keeps marker text live)', async () => {
    const rel = 'never-valid.json';
    const file = path.join(repo, rel);
    await fsp.writeFile(file, 'seed\n');
    run('git add -A && git commit -q -m seed', repo);
    await fsp.writeFile(file, NESTED_DIFF3);

    const result = await healJsonFileFromHistory({
      repoDir: repo, filePath: file, relPath: rel, label: 'conflicted', quarantineOnFailure: true,
    });
    expect(result.action).toBe('quarantined');
    await expect(fsp.stat(file)).rejects.toThrow(); // gone → readers fall back
    expect(await fsp.readFile(result.movedTo!, 'utf-8')).toBe(NESTED_DIFF3);
  });

  it('leaves the file alone when quarantine is not requested and nothing is recoverable', async () => {
    const file = path.join(repo, 'untracked.json');
    await fsp.writeFile(file, NESTED_DIFF3);
    const result = await healJsonFileFromHistory({ repoDir: repo, filePath: file, label: 'conflicted' });
    expect(result.action).toBe('skipped');
    expect(await fsp.readFile(file, 'utf-8')).toBe(NESTED_DIFF3);
  });

  it('refuses a path outside the repo instead of guessing a rev', async () => {
    const outside = path.join(os.tmpdir(), 'walnut-outside.json');
    const result = await healJsonFileFromHistory({ repoDir: repo, filePath: outside, label: 'corrupt' });
    expect(result.action).toBe('skipped');
    expect(result.error).toMatch(/outside repoDir/);
  });

  it('findRepoRootUpward stops at the boundary instead of adopting an ancestor repo', async () => {
    const nested = path.join(repo, 'a', 'b');
    await fsp.mkdir(nested, { recursive: true });
    expect(await findRepoRootUpward(nested, repo)).toBe(repo);

    // Boundary is a NON-repo dir inside the repo → nothing above it is eligible.
    expect(await findRepoRootUpward(nested, path.join(repo, 'a'))).toBeNull();
    // Start dir outside the boundary → refused outright.
    expect(await findRepoRootUpward(os.tmpdir(), repo)).toBeNull();
  });
});
