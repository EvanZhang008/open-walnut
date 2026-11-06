/**
 * The files a task names (src/core/hosts/named-paths.ts): which absolute paths placement
 * checks, and this Mac's own answer for them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTaskDirPath, isUnder, namedPaths, pathsOnHost } from '../../../src/core/hosts/named-paths.js';

describe('namedPaths', () => {
  it('2026-11-05: the review brief a worker wrote on clouddev', () => {
    const text = 'You are a fresh, harsh code reviewer. Read the brief at /home/me/.local/state/open-walnut/tasks/task-1/review-brief-codex.md and follow it exactly (code and screenshots only).';
    expect(namedPaths(text)).toEqual(['/home/me/.local/state/open-walnut/tasks/task-1/review-brief-codex.md']);
  });
  it('quotes, backticks, brackets and trailing punctuation end a path; each path once', () => {
    const text = 'See "/tmp/open-walnut/images/a.png", `~/notes/plan.md`; (/srv/data/x.csv). Again /srv/data/x.csv, then /Users/me/repo/.';
    expect(namedPaths(text)).toEqual(['/tmp/open-walnut/images/a.png', '~/notes/plan.md', '/srv/data/x.csv', '/Users/me/repo']);
  });
  it('never a URL, a relative path, a route of one part or a word with a slash', () => {
    const text = 'Open https://github.com/EvanZhang008/open-walnut/pull/1 and file://x/y, edit src/core/x.ts, call /api, and/or ../up/one.';
    expect(namedPaths(text)).toEqual([]);
  });
  it('at most 12', () => {
    const text = Array.from({ length: 20 }, (_, i) => `/data/f${i}/x`).join(' ');
    expect(namedPaths(text)).toHaveLength(12);
  });
  it('Unicode text around a path', () => {
    // CJK text on both sides of the path.
    expect(namedPaths('\u8bfb\u4e00\u4e0b /home/me/brief.md \u7136\u540e')).toEqual(['/home/me/brief.md']);
  });
});

describe('namedPaths, review round 1', () => {
  it('a folder name in another script stays part of its path, never cut to its parent', () => {
    // "/Users/me/notes/<CJK folder>/x.md"
    expect(namedPaths('Open /Users/me/notes/\u9879\u76ee/x.md now')).toEqual(['/Users/me/notes/\u9879\u76ee/x.md']);
  });
  it('a home folder alone is no path to place by; a line number is not part of the path', () => {
    expect(namedPaths('In /Users/me and /home/me, see /home/me/src/a.ts:42')).toEqual(['/home/me/src/a.ts']);
  });
  it('the cap counts only the paths kept', () => {
    const text = `${Array.from({ length: 13 }, (_, i) => `/repo/f${i}.ts`).join(' ')} /home/me/brief.md`;
    expect(namedPaths(text, (p) => !p.startsWith('/repo/'))).toEqual(['/home/me/brief.md']);
  });
  it('a quoted path keeps its spaces (review round 1, Sol)', () => {
    expect(namedPaths('Read "/home/me/.local/state/open-walnut/tasks/p-1/review notes/brief.md" and `~/My Notes/a b.md`, then /x/y.')).toEqual([
      '/home/me/.local/state/open-walnut/tasks/p-1/review notes/brief.md', '~/My Notes/a b.md', '/x/y',
    ]);
  });
  it('a quote that holds more than a path still gives the path; more home folders alone (review round 2)', () => {
    expect(namedPaths('Read "/home/me/brief.md, then reply" now')).toContain('/home/me/brief.md');
    expect(namedPaths('In /local/home/me and /root/x/y')).toEqual(['/root/x/y']);
  });
  it('a position after a path is not part of it, quoted or not (review round 2, Sol)', () => {
    const B = '/home/me/.local/state/open-walnut/tasks/parent/brief.md';
    expect(namedPaths(`Read \`${B}:42\`, "${B}:42:7", ${B}#L42 and ${B}#L10-L20.`)).toEqual([B]);
  });
  it('a file in a task directory', () => {
    expect(isTaskDirPath('/home/me/.local/state/open-walnut/tasks/dc666739/review-brief.md')).toBe(true);
    expect(isTaskDirPath('/home/me/.local/state/open-walnut/tasks/dc666739')).toBe(false);
    expect(isTaskDirPath('/Applications/Walnut.app')).toBe(false);
  });
});

describe('isUnder', () => {
  it('the folder itself or inside it, never a sibling with the same prefix', () => {
    expect(isUnder('/w/repo/a.ts', '/w/repo')).toBe(true);
    expect(isUnder('/w/repo', '/w/repo/')).toBe(true);
    expect(isUnder('/w/repo2/a.ts', '/w/repo')).toBe(false);
    expect(isUnder('/w/repo/a.ts', '')).toBe(false);
  });
});

describe('pathsOnHost on this Mac', () => {
  it('says which exist, files and folders, with ~ as the home', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-named-paths-'));
    try {
      const file = path.join(dir, 'brief.md');
      fs.writeFileSync(file, 'x');
      const gone = path.join(dir, 'gone.md');
      const home = `~/${path.relative(os.homedir(), dir)}`;
      const homeFile = path.relative(os.homedir(), dir).startsWith('..') ? null : `${home}/brief.md`;
      const asked = [file, dir, gone, ...(homeFile ? [homeFile] : [])];
      expect(await pathsOnHost('__local__', asked)).toEqual({ present: [file, dir, ...(homeFile ? [homeFile] : [])], missing: [gone] });
      expect(await pathsOnHost('__local__', [])).toEqual({ present: [], missing: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a host with no open link could not be asked', async () => {
    expect(await pathsOnHost('nowhere-host', ['/a/b'])).toBeNull();
  });
});

// Review round 4 (Sol): a path relative to the folder the work runs in names a file too, and a
// start that names more files than placement checks is known to.
describe('relative paths and the cap', () => {
  it('reads ./ and ../ paths against the cwd, never a bare word', async () => {
    const { namedPaths, namesTooManyPaths } = await import('../../../src/core/hosts/named-paths.js')
    expect(namedPaths('Read ./review-brief.md, then ../notes/plan.md:12 and src/x.ts.', () => true, { cwd: '/w/repo' }))
      .toEqual(['/w/repo/review-brief.md', '/w/notes/plan.md'])
    expect(namedPaths('Read ./review-brief.md', () => true)).toEqual([])
    // Review round 6 (Sol): a quoted relative path keeps its spaces, never cut at the first one.
    expect(namedPaths('Read "./review notes/brief.md" and `../old plans/a.md:3`, then "./".', () => true, { cwd: '/w/repo' }))
      .toEqual(['/w/repo/review notes/brief.md', '/w/old plans/a.md'])
    expect(namedPaths('Read "./review notes/brief.md"', () => true)).toEqual([])
    const many = Array.from({ length: 13 }, (_, i) => `/data/set/f${i}.md`).join(' ')
    expect(namesTooManyPaths(many)).toBe(true)
    expect(namesTooManyPaths(Array.from({ length: 12 }, (_, i) => `/data/set/f${i}.md`).join(' '))).toBe(false)
  })
})
