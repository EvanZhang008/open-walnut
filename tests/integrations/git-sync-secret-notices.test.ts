/** Private data, including credential-shaped text, follows ordinary git sync. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('private-data-sync'));
import { WALNUT_HOME } from '../../src/constants.js';
import { initSync, commitIfDirty, stageAllForCommit, ensureCriticalIgnores, resetSyncGuardForTest, setRemote, sync } from '../../src/integrations/git-sync.js';
import { releasePrivateDataHolds } from '../../src/integrations/git-sync-private-data.js';
import { SECRET_IGNORE_PATTERNS } from '../../src/integrations/git-sync-secrets.js';
import { listLetters } from '../../src/core/human-inbox/store.js';

const git = async (args: string[], input?: string) => execFileSync('git', args, { cwd: WALNUT_HOME, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const fake = () => ['GOC', 'SPX-', 'aB3_dE5-fG7_hI9-jK1_lM2-nO4Q'].join('');
const holdsPath = () => path.join(WALNUT_HOME, '.git/walnut-secret-holds.json');
async function write(file: string, text: string) { await fs.mkdir(path.dirname(path.join(WALNUT_HOME, file)), { recursive: true }); await fs.writeFile(path.join(WALNUT_HOME, file), text); }
async function head(file: string) { return git(['show', `HEAD:${file}`]); }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetSyncGuardForTest(); initSync();
  await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.net']);
});
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('private data does not hold credentials', () => {
  it('new and tracked documents keep credential-shaped text, sync repeatedly, and create no letter', async () => {
    const names = ['notes/setup.md', 'human-inbox/bodies/old.md', 'notes/my noteé.md'];
    for (const file of names) await write(file, `before\n${fake()}\nafter`);
    expect(await commitIfDirty()).toBe(true);
    for (const file of names) expect(await head(file)).toContain(fake());
    await write(names[0], `updated\n${fake()}\nafter`);
    expect(await commitIfDirty()).toBe(true);
    expect(await head(names[0])).toContain('updated');
    expect(await commitIfDirty()).toBe(false);
    expect((await listLetters()).letters).toEqual([]);
  });

  it('removes old blanket credential filename rules but keeps machine-local stores and user ignores', async () => {
    await fs.appendFile(path.join(WALNUT_HOME, '.gitignore'), '\n' + SECRET_IGNORE_PATTERNS.join('\n') + '\ncustom-private/\n');
    ensureCriticalIgnores(); ensureCriticalIgnores();
    const ignore = await fs.readFile(path.join(WALNUT_HOME, '.gitignore'), 'utf8');
    for (const rule of SECRET_IGNORE_PATTERNS) expect(ignore.split('\n')).not.toContain(rule);
    expect(ignore).toContain('custom-private/'); expect(ignore).toContain('secrets/');
    for (const file of ['notes/.env', 'keys/id_ed25519', 'notes/credentials.json', 'notes/key-store.p12']) await write(file, fake());
    await commitIfDirty();
    for (const file of ['notes/.env', 'keys/id_ed25519', 'notes/credentials.json', 'notes/key-store.p12']) expect(await head(file)).toBe(fake());
  });

  it('old tracked/untracked holds are cleared, while both old sidecar forms are recovered without overwriting incoming content', async () => {
    await write('notes/tracked.md', 'clean'); await commitIfDirty();
    await write('notes/tracked.md', fake()); await write('notes/new.md', fake());
    const aside = 'notes/shared.md.conflicted-secret-old';
    const forgotten = 'notes/forgotten.md.conflicted-secret-old';
    await write(aside, fake()); await write(forgotten, 'forgotten private copy'); await write('notes/shared.md', 'incoming version');
    await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: {
      'notes/tracked.md': { tracked: true }, 'notes/new.md': { tracked: false }, [aside]: { asideOf: 'notes/shared.md' },
    } }));
    await commitIfDirty();
    expect(await head('notes/tracked.md')).toBe(fake()); expect(await head('notes/new.md')).toBe(fake());
    expect(await head('notes/shared.md')).toBe('incoming version');
    const record = JSON.parse(await fs.readFile(holdsPath(), 'utf8'));
    expect(record.holds).toEqual({}); expect(record.privateDataReleased).toBe(true); expect(record.recovered).toHaveLength(2);
    for (const r of record.recovered) expect(await head(r.target)).toBe(await fs.readFile(path.join(WALNUT_HOME, r.source), 'utf8'));
    expect(await fs.readFile(path.join(WALNUT_HOME, aside), 'utf8')).toBe(fake());
    await releasePrivateDataHolds(git, WALNUT_HOME);
    expect(JSON.parse(await fs.readFile(holdsPath(), 'utf8')).recovered).toEqual(record.recovered);
  });

  it('a failed recovery retries safely and never overwrites a different recovery target', async () => {
    const aside = 'notes/a.md.conflicted-secret-old';
    await write(aside, fake());
    await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: { [aside]: { asideOf: '../outside.md' } } }));
    await releasePrivateDataHolds(git, WALNUT_HOME);
    expect(JSON.parse(await fs.readFile(holdsPath(), 'utf8')).privateDataReleased).toBe(false);
    await write('notes/ordinary.md', fake());
    expect(await commitIfDirty()).toBe(true);
    expect(await head('notes/ordinary.md')).toBe(fake());
    await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: { [aside]: { asideOf: 'notes/a.md' } } }));
    await releasePrivateDataHolds(git, WALNUT_HOME);
    const record = JSON.parse(await fs.readFile(holdsPath(), 'utf8'));
    await write(record.recovered[0].target, 'later edit');
    await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: { [aside]: { asideOf: 'notes/a.md' } } }));
    await releasePrivateDataHolds(git, WALNUT_HOME);
    expect(await fs.readFile(path.join(WALNUT_HOME, record.recovered[0].target), 'utf8')).toBe('later edit');
    const next = JSON.parse(await fs.readFile(holdsPath(), 'utf8'));
    expect(next.recovered[0].target).not.toBe(record.recovered[0].target);
    expect(await fs.readFile(path.join(WALNUT_HOME, next.recovered[0].target), 'utf8')).toBe(fake());
  });

  it('missing original directories and one invalid entry never stop recovery or ordinary staging', async () => {
    const aside = 'notes/a.md.conflicted-secret-old'; await write(aside, fake());
    await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: { [aside]: { asideOf: 'gone/dir/a.md' }, 'notes/invalid.conflicted-secret-x': { asideOf: '../outside' } } }));
    await releasePrivateDataHolds(git, WALNUT_HOME);
    const record = JSON.parse(await fs.readFile(holdsPath(), 'utf8'));
    expect(record.recovered).toHaveLength(1);
    expect(record.recovered[0].target).toMatch(/^notes\/a.md.recovered-private-data-/);
    expect(record.privateDataReleased).toBe(false);
    await write('notes/ordinary.md', fake());
    await stageAllForCommit();
    expect(await git(['diff', '--cached', '--name-only'])).toContain('notes/ordinary.md');
  });

  it('a data folder reached through a symbolic link records recovery paths inside the folder', async () => {
    // macOS temp folders sit under /var, a link to /private/var: the recovered copy is built on
    // the resolved path, so its recorded path must be relative to the resolved folder too.
    const link = `${WALNUT_HOME}-link`;
    await fs.rm(link, { force: true }); await fs.symlink(WALNUT_HOME, link, 'dir');
    try {
      const viaLink = async (args: string[], input?: string) => execFileSync('git', args, { cwd: link, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
      const aside = 'notes/deep/a.md.conflicted-secret-old'; await write(aside, fake());
      await fs.writeFile(holdsPath(), JSON.stringify({ version: 2, holds: { [aside]: { asideOf: 'notes/deep/a.md' } } }));
      await releasePrivateDataHolds(viaLink, link);
      const record = JSON.parse(await fs.readFile(holdsPath(), 'utf8'));
      expect(record.privateDataReleased).toBe(true);
      expect(record.recovered).toHaveLength(1);
      expect(record.recovered[0].target).toMatch(/^notes\/deep\/a\.md\.recovered-private-data-[0-9a-f]{16}$/);
      expect(await fs.readFile(path.join(link, record.recovered[0].target), 'utf8')).toBe(fake());
      expect(await commitIfDirty()).toBe(true);
      expect(await head(record.recovered[0].target)).toBe(fake());
    } finally { await fs.rm(link, { force: true }); }
  });

  it('corrupt hold metadata never blocks private data and sidecar discovery is narrowly scoped', async () => {
    await fs.writeFile(holdsPath(), '{bad metadata');
    await write('notes/ordinary.md', fake());
    await stageAllForCommit();
    expect(await git(['diff', '--cached', '--name-only'])).toContain('notes/ordinary.md');
    await fs.rm(holdsPath());
    const calls: string[][] = [];
    await releasePrivateDataHolds(async (args, input) => { calls.push(args); return git(args, input); }, WALNUT_HOME);
    expect(calls.find((a) => a[0] === 'ls-files')).toEqual(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(glob)**/*.conflicted-secret-*']);
  });

  it('concurrent release calls make one copy and replica staging retains its ownership exclusions', async () => {
    const aside = 'notes/a.md.conflicted-secret-old'; await write(aside, fake());
    await Promise.all([releasePrivateDataHolds(git, WALNUT_HOME), releasePrivateDataHolds(git, WALNUT_HOME)]);
    expect(JSON.parse(await fs.readFile(holdsPath(), 'utf8')).recovered).toHaveLength(1);
    await write('notes/replica.md', fake()); await write('human-inbox/bodies/primary.md', fake());
    await stageAllForCommit({ cloudMode: true });
    const staged = await git(['diff', '--cached', '--name-only']);
    expect(staged).toContain('notes/replica.md'); expect(staged).not.toContain('human-inbox/');
  });

  it('real private hub receives credential-shaped documents and subsequent remote merges keep moving', async () => {
    const hub = path.join(WALNUT_HOME, 'tmp/private-hub.git');
    await fs.mkdir(path.dirname(hub), { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', hub]); setRemote(hub);
    await write('notes/shared.md', fake()); await sync();
    expect(execFileSync('git', ['--git-dir', hub, 'show', 'main:notes/shared.md'], { encoding: 'utf8' })).toBe(fake());
    await write('notes/shared.md', `next\n${fake()}`); await sync();
    expect(execFileSync('git', ['--git-dir', hub, 'show', 'main:notes/shared.md'], { encoding: 'utf8' })).toContain('next');
  });
});
