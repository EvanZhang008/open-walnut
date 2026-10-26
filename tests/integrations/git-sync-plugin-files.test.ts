/**
 * plugin-files/<id>/ (walnut.storage.files) is the one folder a plugin writes into
 * the data repo's history. The data repo has been a commit firehose before (1,958
 * commits a day, a 15 GB .git, a 613 MB model file committed by the 30s auto-save),
 * so git itself keeps this folder to small text, whatever a plugin does:
 *
 *   - the .gitignore block lets back in only folders and the text extensions, never
 *     hidden names or node_modules/, and must stay LAST, because git takes the last
 *     matching rule and the unanchored rules above it (images/, tmp/ ...) would hide
 *     a plugin's own folder of that name; its rules are only ever added to, so two
 *     builds sharing the repo never rewrite it back and forth;
 *   - a NEW file that is too big, binary or a link is kept out of the commit, judged
 *     by what was staged, and listed in plugin-files/.gitignore so later adds skip it
 *     until it fits; a tracked file is never unstaged (a dirty tracked file stops
 *     `pull --rebase`);
 *   - a replica never stages the folder at all.
 *
 * A REAL git repo in an isolated WALNUT_HOME, driven through the real entry points
 * (initSync, ensureCriticalIgnores, stageAllForCommit); assertions read git's answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-files-git'));

import {
  PLUGIN_FILES_IGNORE_BLOCK,
  ensureCriticalIgnores,
  initSync,
  stageAllForCommit,
  withPluginFilesBlockLast,
} from '../../src/integrations/git-sync.js';
import { SYNCED_FILE_MAX_BYTES } from '../../src/core/plugins/plugin-file-rules.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';

function gitOut(args: string): string {
  return execSync(`git ${args}`, { cwd: WALNUT_HOME, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function stagedPaths(): string[] {
  const out = execSync('git diff --cached --name-only -z', { cwd: WALNUT_HOME, encoding: 'utf-8' });
  return out.split('\0').filter(Boolean).sort();
}

function write(rel: string, content: string | Buffer): void {
  const full = path.join(WALNUT_HOME, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function ignoresCase(): boolean {
  try { return gitOut('config --get core.ignorecase') === 'true'; } catch { return false; }
}

const gitignore = () => fs.readFileSync(path.join(WALNUT_HOME, '.gitignore'), 'utf-8');

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  initSync();
  write('seed.txt', 'seed\n');
  gitOut('add -A');
  gitOut('commit -q -m seed');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('the .gitignore block', () => {
  it('a new install gets it last', () => {
    const lines = gitignore().trimEnd().split('\n');
    expect(lines.slice(-PLUGIN_FILES_IGNORE_BLOCK.length)).toEqual(PLUGIN_FILES_IGNORE_BLOCK);
  });

  it('git tracks the text, even in folders other rules ignore, and nothing else', async () => {
    write('plugin-files/practice/reviews/two-sum.md', '# review\n');
    write('plugin-files/practice/mistakes.json', '[]\n');
    write('plugin-files/practice/images/caption.txt', 'a folder named images\n');
    write('plugin-files/practice/tmp/rules.yaml', 'a: 1\n');
    write('plugin-files/practice/upper.MD', 'case\n');
    // Hidden names and installed packages: never, whatever the extension.
    write('plugin-files/practice/node_modules/pkg/package.json', '{}');
    write('plugin-files/practice/.obsidian/workspace.json', '{}');
    write('plugin-files/practice/notes/.draft.md', 'x');
    // Not text: never tracked.
    write('plugin-files/practice/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('plugin-files/practice/cache.sqlite', 'x');
    write('plugin-files/practice/model.onnx', 'x');
    write('plugin-files/practice/run.log', 'x');
    write('plugin-files/practice/.open-walnut-0123456789abcdef.tmp', 'x');
    write('plugin-files/practice/noext', 'x');
    // The rest of the repo keeps its rules: images/ at the root is still ignored.
    write('images/root.md', 'still ignored\n');

    await stageAllForCommit({ cloudMode: false });

    const staged = stagedPaths();
    expect(staged.filter((p) => p.startsWith('plugin-files/'))).toEqual([
      'plugin-files/practice/images/caption.txt',
      'plugin-files/practice/mistakes.json',
      'plugin-files/practice/reviews/two-sum.md',
      'plugin-files/practice/tmp/rules.yaml',
      // Case-insensitive file systems match *.md to upper.MD only when git ignores case.
      ...(ignoresCase() ? ['plugin-files/practice/upper.MD'] : []),
    ]);
    expect(staged).not.toContain('images/root.md');
  });

  it('a boot moves it back to the end when lines were appended after it, and is then a no-op', () => {
    fs.appendFileSync(path.join(WALNUT_HOME, '.gitignore'), '\n# my own rule\n*.md\n');
    ensureCriticalIgnores();
    const once = gitignore();
    expect(once.trimEnd().split('\n').slice(-PLUGIN_FILES_IGNORE_BLOCK.length)).toEqual(PLUGIN_FILES_IGNORE_BLOCK);
    expect(once).toContain('# my own rule\n*.md\n');
    ensureCriticalIgnores();
    expect(gitignore()).toBe(once);
  });

  it('an install from before the block gets it, after the critical lines it was missing', () => {
    fs.writeFileSync(path.join(WALNUT_HOME, '.gitignore'), 'images/\n*.log\n');
    ensureCriticalIgnores();
    const lines = gitignore().trimEnd().split('\n');
    expect(lines.slice(-PLUGIN_FILES_IGNORE_BLOCK.length)).toEqual(PLUGIN_FILES_IGNORE_BLOCK);
    expect(lines.indexOf('plugin-data/')).toBeGreaterThan(-1);
    expect(lines.indexOf('plugin-data/')).toBeLessThan(lines.indexOf(PLUGIN_FILES_IGNORE_BLOCK[0]));
  });

  it('rules are only added, never moved, so two builds sharing the repo settle on one file', () => {
    const [start, ...rest] = PLUGIN_FILES_IGNORE_BLOCK;
    const end = rest.pop()!;
    // A newer build's block, with a rule this build does not know in the middle: kept as it is.
    const newer = `images/\n\n${[start, ...rest.slice(0, 3), '!/plugin-files/**/*.rst', ...rest.slice(3), end].join('\n')}\n`;
    expect(withPluginFilesBlockLast(newer)).toBe(newer);
    // An older build's block, a rule short: the missing rule goes at its end, and that settles.
    const older = `images/\n\n${[start, ...rest.slice(0, -1), end].join('\n')}\n`;
    const upgraded = withPluginFilesBlockLast(older);
    expect(upgraded).toBe(`images/\n\n${PLUGIN_FILES_IGNORE_BLOCK.join('\n')}\n`);
    expect(withPluginFilesBlockLast(upgraded)).toBe(upgraded);
    // Moved last again without losing a rule.
    const appended = `${newer}*.md\n`;
    expect(withPluginFilesBlockLast(appended)).toBe(`images/\n*.md\n\n${[start, ...rest.slice(0, 3), '!/plugin-files/**/*.rst', ...rest.slice(3), end].join('\n')}\n`);
  });

  it('a block cut in half by a hand edit is made whole again, once', () => {
    const half = `images/\n\n${PLUGIN_FILES_IGNORE_BLOCK.slice(0, 3).join('\n')}\nmine/\n`;
    const fixed = withPluginFilesBlockLast(half);
    expect(fixed).toBe(`images/\nmine/\n\n${PLUGIN_FILES_IGNORE_BLOCK.join('\n')}\n`);
    expect(withPluginFilesBlockLast(fixed)).toBe(fixed);
    expect(withPluginFilesBlockLast('')).toBe(`${PLUGIN_FILES_IGNORE_BLOCK.join('\n')}\n`);
  });
});

describe('a file unfit for the history stays out of the commit', () => {
  it('a new file over the limit, or holding binary data, is left untracked on disk', async () => {
    const warn = vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    write('plugin-files/practice/big.json', `"${'x'.repeat(SYNCED_FILE_MAX_BYTES)}"`);
    write('plugin-files/practice/binary.txt', Buffer.from('text\0more'));
    write('plugin-files/practice/fine.md', 'ok\n');

    await stageAllForCommit({ cloudMode: false });

    expect(stagedPaths().filter((p) => p.startsWith('plugin-files/'))).toEqual(['plugin-files/practice/fine.md']);
    expect(fs.existsSync(path.join(WALNUT_HOME, 'plugin-files/practice/big.json'))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0][1])).toContain('binary data');
    // Listed locally, so the next add does not hash them again and the tree reads clean.
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'plugin-files/.gitignore'), 'utf-8')).toContain('/practice/big.json\n/practice/binary.txt\n');
    gitOut('commit -q -m tick');
    expect(gitOut('status --porcelain -uall')).toBe('');

    // The next tick says nothing new about the same files.
    await stageAllForCommit({ cloudMode: false });
    expect(stagedPaths()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Once a file fits again it comes back in at the next tick; the one still binary stays out.
    write('plugin-files/practice/big.json', '"small now"');
    await stageAllForCommit({ cloudMode: false });
    expect(stagedPaths()).toEqual(['plugin-files/practice/big.json']);
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'plugin-files/.gitignore'), 'utf-8')).not.toContain('big.json');
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'plugin-files/.gitignore'), 'utf-8')).toContain('/practice/binary.txt');
  });

  it('a new big file that looks like a move of a tracked one is still new', async () => {
    vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    // A big file an older build committed; then the plugin moves it. Rename detection
    // would show the new path as R, not A, and let it in.
    const big = `"${'y'.repeat(SYNCED_FILE_MAX_BYTES)}"`;
    write('plugin-files/practice/old.json', big);
    gitOut('add -A');
    gitOut('commit -q -m old');
    fs.rmSync(path.join(WALNUT_HOME, 'plugin-files/practice/old.json'));
    write('plugin-files/practice/moved.json', `${big} `);

    await stageAllForCommit({ cloudMode: false });

    expect(gitOut('diff --cached --no-renames --name-status')).toBe('D\tplugin-files/practice/old.json');
  });

  it('a symlink or a nested repository is kept out as well', async () => {
    vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    write('plugin-files/practice/real.md', 'real\n');
    fs.symlinkSync('/etc/hosts', path.join(WALNUT_HOME, 'plugin-files/practice/link.md'));
    const nested = path.join(WALNUT_HOME, 'plugin-files/practice/checkout');
    fs.mkdirSync(nested, { recursive: true });
    execSync('git init -q && git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m x', { cwd: nested });
    fs.writeFileSync(path.join(nested, 'readme.md'), 'inside a nested repo\n');

    await stageAllForCommit({ cloudMode: false });

    expect(stagedPaths().filter((p) => p.startsWith('plugin-files/'))).toEqual(['plugin-files/practice/real.md']);
  });

  it('a file name a shell would read as code is only ever a path', async () => {
    vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    const names = ['$(touch pwned).json', '`touch pwned`.md', 'quote"s.txt', 'star*.md', 'space name.md'];
    for (const name of names) write(`plugin-files/practice/${name}`, Buffer.from('a\0b'));
    write('plugin-files/practice/keep.md', 'kept');

    await stageAllForCommit({ cloudMode: false });

    expect(stagedPaths().filter((p) => p.startsWith('plugin-files/'))).toEqual(['plugin-files/practice/keep.md']);
    expect(fs.existsSync(path.join(WALNUT_HOME, 'pwned'))).toBe(false);
    for (const name of names) expect(fs.existsSync(path.join(WALNUT_HOME, 'plugin-files/practice', name))).toBe(true);
    // Each is matched exactly by its line in plugin-files/.gitignore (a star is a star), so the tree reads clean.
    gitOut('commit -q -m keep');
    expect(gitOut('status --porcelain -uall')).toBe('');
    write('plugin-files/practice/starry.md', 'a star in the line above must not hide this\n');
    await stageAllForCommit({ cloudMode: false });
    expect(stagedPaths()).toEqual(['plugin-files/practice/starry.md']);
  });

  it('a tracked file that grew past the limit leaves the history, stays on disk, and nothing is left dirty', async () => {
    vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    write('plugin-files/practice/log.json', '[]');
    await stageAllForCommit({ cloudMode: false });
    gitOut('commit -q -m add');
    write('plugin-files/practice/log.json', `"${'x'.repeat(SYNCED_FILE_MAX_BYTES)}"`);

    await stageAllForCommit({ cloudMode: false });

    expect(gitOut('diff --cached --no-renames --name-status')).toBe('D\tplugin-files/practice/log.json');
    gitOut('commit -q -m tick');
    // Clean: a dirty tracked file would make the next pull --rebase refuse.
    expect(gitOut('status --porcelain -uall')).toBe('');
    expect(fs.statSync(path.join(WALNUT_HOME, 'plugin-files/practice/log.json')).size).toBeGreaterThan(SYNCED_FILE_MAX_BYTES);
    // A tracked text file that turns into a link goes the same way.
    write('plugin-files/practice/notes.md', 'notes\n');
    await stageAllForCommit({ cloudMode: false });
    gitOut('commit -q -m notes');
    fs.rmSync(path.join(WALNUT_HOME, 'plugin-files/practice/notes.md'));
    fs.symlinkSync('/etc/hosts', path.join(WALNUT_HOME, 'plugin-files/practice/notes.md'));
    await stageAllForCommit({ cloudMode: false });
    expect(gitOut('diff --cached --no-renames --name-status')).toBe('D\tplugin-files/practice/notes.md');
  });

  it('a nested repository without a commit never stops the sync of everything else', async () => {
    const warn = vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    const nested = path.join(WALNUT_HOME, 'plugin-files/practice/clone');
    fs.mkdirSync(nested, { recursive: true });
    execSync('git init -q', { cwd: nested });
    fs.writeFileSync(path.join(nested, 'readme.md'), 'inside\n');
    write('plugin-files/practice/review.md', 'review\n');
    write('seed.txt', 'seed changed\n');

    await stageAllForCommit({ cloudMode: false });

    expect(stagedPaths()).toEqual(['plugin-files/practice/review.md', 'seed.txt']);
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'plugin-files/.gitignore'), 'utf-8')).toContain('/practice/clone/\n');
    expect(JSON.stringify(warn.mock.calls)).toContain('nested repository');
    gitOut('commit -q -m tick');
    expect(gitOut('status --porcelain -uall')).toBe('');
    // No longer a repository: its text syncs again.
    fs.rmSync(path.join(nested, '.git'), { recursive: true, force: true });
    await stageAllForCommit({ cloudMode: false });
    expect(stagedPaths()).toEqual(['plugin-files/practice/clone/readme.md']);
  });

  it('a fresh repo\'s first commit leaves plugin-files/ to the guarded tick', async () => {
    await fsp.rm(path.join(WALNUT_HOME, '.git'), { recursive: true, force: true });
    const nested = path.join(WALNUT_HOME, 'plugin-files/practice/clone');
    fs.mkdirSync(nested, { recursive: true });
    execSync('git init -q', { cwd: nested });
    write('plugin-files/practice/big.json', `"${'z'.repeat(SYNCED_FILE_MAX_BYTES)}"`);
    write('plugin-files/practice/review.md', 'review\n');

    initSync();

    expect(gitOut('log --oneline').split('\n')).toHaveLength(1);
    expect(gitOut('ls-files -- plugin-files')).toBe('');
    vi.spyOn(log.git, 'warn').mockImplementation(() => undefined);
    await stageAllForCommit({ cloudMode: false });
    expect(stagedPaths().filter((p) => p.startsWith('plugin-files/'))).toEqual(['plugin-files/practice/review.md']);
  });
});

describe('a replica', () => {
  it('never stages plugin-files, and puts a stale local change back to HEAD', async () => {
    write('plugin-files/practice/review.md', 'from the primary\n');
    await stageAllForCommit({ cloudMode: false });
    gitOut('commit -q -m primary');

    vi.spyOn(log.git, 'error').mockImplementation(() => undefined);
    write('plugin-files/practice/review.md', 'a replica edit\n');
    write('plugin-files/practice/new.md', 'new on the replica\n');
    write('tasks/tasks.json', '{"tasks":[]}');

    await stageAllForCommit({ cloudMode: true });

    const staged = stagedPaths();
    expect(staged).toContain('tasks/tasks.json');
    expect(staged.filter((p) => p.startsWith('plugin-files/'))).toEqual([]);
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'plugin-files/practice/review.md'), 'utf-8')).toBe('from the primary\n');
  });
});
