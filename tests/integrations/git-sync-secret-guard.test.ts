/**
 * Secret guard for the data repo's auto-commits (git-sync-secrets.ts).
 *
 * Incident: on 2026-07-26 the 30s auto-save committed
 * `sync/.open-walnut-<hash>.tmp`, the atomic-write temp of the Microsoft To Do
 * sign-in cache (an access token plus an MSAL refresh token). The .gitignore
 * listed the cache, not its temp, and `git add -A` takes anything not listed.
 *
 * The rule these tests pin: whatever a file is called, a commit made by git-sync
 * never holds a credential. Real git repos throughout; every fake credential is
 * built at runtime from a seeded generator, so this file holds none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';
import { removeTempTree } from '../helpers/temp-home.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-secretguard-test'));

import {
  initSync,
  commitIfDirty,
  ensureMachineLocalUntracked,
  resetSyncGuardForTest,
  setRemote,
  stageAllForCommit,
  sync,
} from '../../src/integrations/git-sync.js';
import {
  findSecretsInText,
  findSecretsInTextAsync,
  holdStagedSecrets,
  resetSecretScanCacheForTest,
  secretPathKind,
  setSecretHoldNotifierForTest,
  type SecretHoldNotice,
} from '../../src/integrations/git-sync-secrets.js';
import { WALNUT_HOME } from '../../src/constants.js';

// ── Fake credentials, built at runtime ─────────────────────────────────────

let seed = 0x5eed;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randFrom(alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = ALNUM + '-_';
const fake = {
  github: () => ['gh', 'p_', randFrom(ALNUM, 36)].join(''),
  aws: () => ['AK', 'IA', randFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)].join(''),
  google: () => ['AI', 'za', randFrom(B64URL, 35)].join(''),
  slack: () => ['xo', 'xb-', randFrom('0123456789', 12), '-', randFrom('0123456789', 12), '-', randFrom(ALNUM, 24)].join(''),
  pem: () => ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', randFrom(ALNUM + '+/', 64), '\n-----END RSA PRIVATE KEY-----'].join(''),
  opaque: (n = 120) => randFrom(ALNUM + '-_.', n),
  jwt: () => ['ey', 'J', randFrom(B64URL, 30), '.ey', 'J', randFrom(B64URL, 60), '.', randFrom(B64URL, 43)].join(''),
};

/** The shape of the file that leaked: the MSAL cache is JSON stored as a string inside JSON. */
function msalCacheFile(): string {
  const inner = JSON.stringify({
    AccessToken: { k: { credential_type: 'AccessToken', secret: fake.opaque(1400) } },
    RefreshToken: { k: { credential_type: 'RefreshToken', secret: fake.opaque(390) } },
  });
  return JSON.stringify({ accessToken: fake.opaque(1400), expiresAt: '2026-07-25T17:55:18.000Z', msalCache: inner }, null, 2);
}

// ── Rules ────────────────────────────────────────────────────────────────────

describe('findSecretsInText', () => {
  it('finds each kind of credential, by kind and line, never by value', () => {
    const cases: Array<[string, string]> = [
      ['github-token', `token = ${fake.github()}`],
      ['aws-access-key', `key: ${fake.aws()}`],
      ['google-api-key', `"key": "${fake.google()}"`],
      ['slack-token', `SLACK=${fake.slack()}`],
      ['private-key', fake.pem()],
      ['oauth-token-field', `{"refresh_token": "${fake.opaque(80)}"}`],
      ['jwt', `Authorization: Bearer ${fake.jwt()}`],
      ['url-credentials', `origin https://walnut:${randFrom('0123456789abcdef', 32)}@hub.example.net/git/data`],
    ];
    for (const [kind, text] of cases) {
      const found = findSecretsInText(`line one\n${text}\n`);
      expect(found, kind).toContainEqual({ kind, line: 2 });
      expect(JSON.stringify(found)).not.toContain(text.slice(-20));
    }
  });

  it('finds the leaked MSAL cache shape, escaped quotes and all', () => {
    const kinds = findSecretsInText(msalCacheFile()).map((f) => f.kind);
    expect(kinds).toContain('msal-credential');
    expect(kinds).toContain('oauth-token-field');
  });

  it('leaves placeholders, references and low-entropy text alone', () => {
    const benign = [
      `aws key ${['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('')} from the docs`,
      `"access_token": "\${ACCESS_TOKEN_FROM_ENV_VARIABLE_PLEASE_SET}"`,
      `"refresh_token": "${'a'.repeat(60)}"`,
      'https://walnut:<device-token>@example.net/git/data',
      'https://user:password@host',
      ['xo', 'xb-000000000000-000000000000-', 'x'.repeat(24)].join(''),
      'function accessToken() { return cache.accessToken }',
      'the words PRIVATE KEY in prose',
    ];
    for (const text of benign) expect(findSecretsInText(text), text).toEqual([]);
  });

  it('names credential stores by path', () => {
    expect(secretPathKind('.env')).toBe('env-file');
    expect(secretPathKind('notes/app/.env.local')).toBe('env-file');
    expect(secretPathKind('notes/app/.env.example')).toBeNull();
    expect(secretPathKind('keys/id_ed25519')).toBe('ssh-key');
    expect(secretPathKind('a/store.p12')).toBe('key-store');
    expect(secretPathKind('notes/env.md')).toBeNull();
    expect(secretPathKind('notes/keys.md')).toBeNull();
  });

  it('finds Slack tokens of the newer formats and a bearer token', () => {
    const rotating = ['xo', 'xe.xo', 'xp-1-', randFrom(ALNUM, 40)].join('');
    expect(findSecretsInText(rotating).map((f) => f.kind)).toEqual(['slack-token']);
    expect(findSecretsInText(`-H "Authorization: Bearer ${fake.opaque(48)}"`).map((f) => f.kind)).toContain('bearer-token');
    expect(findSecretsInText('-H "Authorization: Bearer $TOKEN"')).toEqual([]);
  });

  it('scans text of any size in slices, a credential on a slice edge included', async () => {
    const key = fake.github();
    const filler = 'x'.repeat(256 * 1024 - 11) + ' ';
    expect(await findSecretsInTextAsync(`${filler}${key}\nmore\n`)).toEqual([{ kind: 'github-token', line: 1 }]);
    const lines = Array.from({ length: 30000 }, (_, i) => `line ${i} of a long transcript`);
    lines[25000] = `token ${key}`;
    expect(await findSecretsInTextAsync(lines.join('\n'))).toEqual([{ kind: 'github-token', line: 25001 }]);
  });
});

// ── Real repo ────────────────────────────────────────────────────────────────

let repo: string;
let notices: SecretHoldNotice[];

function run(cmd: string, cwd = repo): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function showHead(rel: string, cwd = repo): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}
async function writeFile(rel: string, content: string, root = repo): Promise<void> {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf-8');
}
const realGit = (cwd: string) => async (args: string[], input?: string) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const holdsFile = () => path.join(repo, '.git', 'walnut-secret-holds.json');

beforeEach(async () => {
  repo = WALNUT_HOME;
  await removeTempTree(repo);
  await fsp.mkdir(repo, { recursive: true });
  resetSyncGuardForTest();
  notices = [];
  resetSecretScanCacheForTest();
  setSecretHoldNotifierForTest((notice) => { notices.push(notice); });
  initSync();
  run('git config user.email t@t && git config user.name t');
});

afterEach(async () => {
  setSecretHoldNotifierForTest(null);
  await removeTempTree(repo);
});

describe('auto-commit with the secret guard', () => {
  it('the incident: an unlisted temp of the sign-in cache is kept out, the rest of the tick commits', async () => {
    // A name no ignore rule lists, so only the content scan stands between it and the hub.
    const leaked = msalCacheFile();
    await writeFile('sync/.ms-cache-4f2a.swp', leaked);
    await writeFile('notes/today.md', '# today\n');

    expect(await commitIfDirty()).toBe(true);

    expect(showHead('notes/today.md')).toBe('# today\n');
    expect(run('git log --all --format=%H -- sync/.ms-cache-4f2a.swp')).toBe('');
    // The file is untouched on disk, and later ticks keep it out without a new letter.
    expect(fs.readFileSync(path.join(repo, 'sync/.ms-cache-4f2a.swp'), 'utf-8')).toBe(leaked);
    await writeFile('notes/today.md', '# today 2\n');
    expect(await commitIfDirty()).toBe(true);
    expect(run('git log --all --format=%H -- sync/.ms-cache-4f2a.swp')).toBe('');
    expect(await commitIfDirty()).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0].event).toBe('held');
    expect(notices[0].files.map((f) => f.file)).toEqual(['sync/.ms-cache-4f2a.swp']);
    expect(notices[0].files[0].hold.kinds).toContain('msal-credential');
    expect(JSON.stringify(notices)).not.toContain(leaked.slice(60, 120));
  });

  it('names with spaces, unicode and quotes are scanned and held', async () => {
    const names = ['notes/my note é.md', 'notes/say "hi".md', 'notes/tab\tname.md'];
    for (const name of names) await writeFile(name, `k ${fake.github()}\n`);
    await commitIfDirty();
    for (const name of names) expect(showHead(name), name).toBeNull();
    expect(notices[0].files.map((f) => f.file).sort()).toEqual([...names].sort());
  });

  it('a content line that starts with "++ " is content, not a file header', async () => {
    await writeFile('notes/c.md', `++ c\n${fake.github()}\n`);
    await writeFile('notes/d.md', 'plain\n');
    await commitIfDirty();
    expect(showHead('notes/c.md')).toBeNull();
    expect(showHead('notes/d.md')).toBe('plain\n');
  });

  it('a tracked note that gains a secret keeps its last clean version in history, and syncs again once cleaned', async () => {
    await writeFile('notes/setup.md', '# setup\n');
    await commitIfDirty();
    const key = fake.github();
    await writeFile('notes/setup.md', `# setup\nmy token ${key}\n`);

    await commitIfDirty();

    expect(showHead('notes/setup.md')).toBe('# setup\n');
    expect(run('git log -p --all')).not.toContain(key);
    expect(run('git status --porcelain')).toBe('M notes/setup.md');
    expect(fs.readFileSync(path.join(repo, 'notes/setup.md'), 'utf-8')).toContain(key);
    expect(notices.map((n) => n.event)).toEqual(['held']);
    expect(notices[0].files[0].hold).toMatchObject({ kinds: ['github-token'], lines: [2], tracked: true });

    // Still held while the secret stays, whatever else changes.
    await writeFile('notes/setup.md', `# setup v2\nmy token ${key}\n`);
    await commitIfDirty();
    expect(showHead('notes/setup.md')).toBe('# setup\n');
    expect(notices).toHaveLength(1);

    await writeFile('notes/setup.md', '# setup v3\ntoken now lives in Settings\n');
    expect(await commitIfDirty()).toBe(true);

    expect(showHead('notes/setup.md')).toBe('# setup v3\ntoken now lives in Settings\n');
    expect(notices.map((n) => n.event)).toEqual(['held', 'released']);
    expect(notices[1].op).toBe(notices[0].op);
    expect(JSON.parse(fs.readFileSync(holdsFile(), 'utf-8')).holds).toEqual({});
    expect(run('git log -p --all')).not.toContain(key);
  });

  it('a credential already in history does not hold a file whose new edit is clean', async () => {
    const old = fake.github();
    await writeFile('notes/legacy.md', `old ${old}\n`);
    run('git add -A && git commit -q -m "before the guard"');
    await writeFile('notes/legacy.md', `old ${old}\nnew clean line\n`);
    expect(await commitIfDirty()).toBe(true);
    expect(showHead('notes/legacy.md')).toBe(`old ${old}\nnew clean line\n`);
    expect(notices).toEqual([]);
  });

  it('a tracked credential store whose value rotates is held, though no added line looks like a key', async () => {
    await fsp.writeFile(path.join(repo, '.gitignore'), '');
    await writeFile('cache/msal.json', msalCacheFile());
    run('git add -A && git commit -q -m "a cache tracked before the guard"');
    await writeFile('cache/msal.json', msalCacheFile());
    await commitIfDirty();
    expect(notices.map((n) => n.event)).toEqual(['held']);
    expect(run('git diff --stat HEAD~0 -- cache/msal.json')).not.toBe('');
    expect(run('git log --format=%s -1')).toBe('a cache tracked before the guard');
  });

  it('a held tracked file put back to its committed version ends its hold', async () => {
    await writeFile('notes/r.md', 'clean\n');
    await commitIfDirty();
    await writeFile('notes/r.md', `clean\n${fake.github()}\n`);
    await commitIfDirty();
    await writeFile('notes/r.md', 'clean\n');
    await writeFile('notes/s.md', 's\n');
    await commitIfDirty();
    expect(notices.map((n) => n.event)).toEqual(['held', 'released']);
  });

  it('a held file that is deleted ends its hold', async () => {
    await writeFile('notes/key.txt', fake.pem());
    await commitIfDirty();
    await fsp.rm(path.join(repo, 'notes/key.txt'));
    await writeFile('notes/other.md', 'x\n');
    await commitIfDirty();
    expect(JSON.parse(fs.readFileSync(holdsFile(), 'utf-8')).holds).toEqual({});
    expect(notices.map((n) => n.event)).toEqual(['held', 'released']);
  });

  it('a lost hold record changes nothing: the scan holds the file again', async () => {
    const key = fake.github();
    await writeFile('notes/k.md', `t ${key}\n`);
    await commitIfDirty();
    await fsp.rm(holdsFile());
    resetSecretScanCacheForTest();
    await writeFile('notes/z.md', 'z\n');
    await commitIfDirty();
    expect(showHead('notes/k.md')).toBeNull();
    expect(run('git log -p --all')).not.toContain(key);
  });

  it('a credential store by name is held even with the ignore rules gone', async () => {
    await fsp.writeFile(path.join(repo, '.gitignore'), '');
    run('git add .gitignore && git commit -q -m "drop ignores"');
    await writeFile('project/.env', 'NOTHING_SECRET_LOOKING=1\n');
    await commitIfDirty();
    expect(showHead('project/.env')).toBeNull();
    expect(notices[0].files[0]).toMatchObject({ file: 'project/.env', hold: { kinds: ['env-file'] } });
  });

  it('several new files in one tick get one letter', async () => {
    await writeFile('a/one.md', `x ${fake.github()}\n`);
    await writeFile('b/two.json', `{"client_secret": "${fake.opaque(48)}"}\n`);
    await commitIfDirty();
    expect(notices).toHaveLength(1);
    expect(notices[0].files.map((f) => f.file).sort()).toEqual(['a/one.md', 'b/two.json']);
  });

  it('the replica stage holds secrets too', async () => {
    await writeFile('notes/r.md', `see ${fake.aws()}\n`);
    await writeFile('notes/ok.md', 'ok\n');
    await stageAllForCommit({ cloudMode: true });
    const staged = run('git diff --cached --name-only');
    expect(staged).toContain('notes/ok.md');
    expect(staged).not.toContain('notes/r.md');
  });

  it('when a held file cannot be taken out of the index, it throws and so nothing is committed', async () => {
    await writeFile('notes/s.md', `t ${fake.github()}\n`);
    run('git add -A');
    const base = realGit(repo);
    const failing = (args: string[], input?: string) => args.includes('rm') ? Promise.reject(new Error('index locked')) : base(args, input);
    await expect(holdStagedSecrets(failing, repo)).rejects.toThrow(/could not keep/);
  });

  it('a first sync of a folder that already holds a credential commits only the .gitignore at init', async () => {
    await removeTempTree(repo);
    await fsp.mkdir(repo, { recursive: true });
    await writeFile('sync/old-cache.tmp', msalCacheFile());
    await writeFile('notes/a.md', 'a\n');
    initSync();
    run('git config user.email t@t && git config user.name t');
    expect(run('git ls-tree -r --name-only HEAD')).toBe('.gitignore');
    await commitIfDirty();
    expect(showHead('notes/a.md')).toBe('a\n');
    expect(showHead('sync/old-cache.tmp')).toBeNull();
  });

  it('the .gitignore template lists credential stores by name', () => {
    const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8');
    for (const line of ['.env', '.env.*', '!.env.example', 'id_ed25519', '*.p12', '.netrc']) expect(gitignore.split('\n')).toContain(line);
  });

  it('the editor instance file is machine-local: an install that tracked it untracks it, the file stays', async () => {
    await writeFile('code-server/instance.json', '{"port":1,"pid":2}\n');
    run('git add -f code-server/instance.json && git commit -q -m "older install"');
    ensureMachineLocalUntracked();
    await commitIfDirty();
    expect(showHead('code-server/instance.json')).toBeNull();
    expect(fs.existsSync(path.join(repo, 'code-server/instance.json'))).toBe(true);
    expect(run('git check-ignore code-server/instance.json')).toBe('code-server/instance.json');
  });

  it('scans a big first commit without stalling: 6 MB of transcripts', async () => {
    const line = JSON.stringify({ role: 'assistant', text: 'ran npm test, 42 passed, accessToken() returns the cached value' });
    for (let i = 0; i < 6; i++) await writeFile(`sessions/transcripts/t${i}.json`, Array.from({ length: 9000 }, () => line).join('\n'));
    let longestGap = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); longestGap = Math.max(longestGap, now - last); last = now; }, 5);
    const started = Date.now();
    try {
      expect(await commitIfDirty()).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(longestGap).toBeLessThan(500);
    expect(notices).toEqual([]);
  }, 30_000);
});

describe('a held file over a real origin', () => {
  let bareDir: string;
  let cloneDir: string;

  beforeEach(async () => {
    bareDir = `${WALNUT_HOME}-origin.git`;
    cloneDir = `${WALNUT_HOME}-clone`;
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
    await fsp.mkdir(bareDir, { recursive: true });
    run('git init -q --bare -b main', bareDir);
    setRemote(bareDir);
    await writeFile('notes/shared.md', 'v1\n');
    await writeFile('notes/other.md', 'o1\n');
    run('git add -A && git commit -q -m base && git push -q -u origin main');
    run(`git clone -q "${bareDir}" "${cloneDir}"`);
    run('git config user.email other@t && git config user.name other', cloneDir);
  });

  afterEach(async () => {
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
  });

  it('a held file stays on this box, the hub keeps its clean version, and a pull that does not touch it runs', async () => {
    const key = fake.github();
    await writeFile('notes/shared.md', `v1\n${key}\n`);
    await writeFile('notes/new.md', 'from the other box\n', cloneDir);
    run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);

    await sync();
    await writeFile('notes/mine.md', 'mine\n');
    await sync();

    expect(fs.readFileSync(path.join(repo, 'notes/new.md'), 'utf-8')).toBe('from the other box\n');
    expect(fs.readFileSync(path.join(repo, 'notes/shared.md'), 'utf-8')).toContain(key);
    expect(run('git show origin/main:notes/shared.md')).toBe('v1');
    expect(run('git show origin/main:notes/mine.md')).toBe('mine');
    expect(run('git log -p --all', bareDir)).not.toContain(key);
    expect(run('git status --porcelain')).toBe('M notes/shared.md');
  }, 60_000);

  it('a lost hold record is rebuilt by the next stage, before that tick pulls', async () => {
    const key = fake.github();
    await writeFile('notes/shared.md', `v1 local\n${key}\n`);
    await commitIfDirty();
    await fsp.rm(holdsFile());
    resetSecretScanCacheForTest();
    await writeFile('notes/shared.md', 'v2 from the other box\n', cloneDir);
    run('git commit -q -am other && git push -q origin main', cloneDir);

    await sync();

    expect(fs.readFileSync(path.join(repo, 'notes/shared.md'), 'utf-8')).toBe('v2 from the other box\n');
    expect(fs.readdirSync(path.join(repo, 'notes')).some((f) => f.startsWith('shared.md.conflicted-secret-'))).toBe(true);
    expect(run('git log -p --all', bareDir)).not.toContain(key);
  }, 60_000);

  it('the other box changing the held file: the local copy is set aside, the change lands, no secret reaches the hub', async () => {
    const key = fake.github();
    await writeFile('notes/shared.md', `v1 local\n${key}\n`);
    await commitIfDirty();
    expect(notices.map((n) => n.event)).toEqual(['held']);
    await writeFile('notes/shared.md', 'v2 from the other box\n', cloneDir);
    run('git commit -q -am other && git push -q origin main', cloneDir);

    await sync();

    expect(fs.readFileSync(path.join(repo, 'notes/shared.md'), 'utf-8')).toBe('v2 from the other box\n');
    const aside = fs.readdirSync(path.join(repo, 'notes')).filter((f) => f.startsWith('shared.md.conflicted-secret-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, 'notes', aside[0]), 'utf-8')).toContain(key);
    expect(run(`git ls-files "notes/${aside[0]}"`)).toBe('');
    expect(notices.map((n) => n.event)).toEqual(['held', 'set-aside']);
    await sync();
    expect(run('git log -p --all', bareDir)).not.toContain(key);
    expect(run('git status --porcelain')).toBe('');
  }, 60_000);

  it('the other box deleting a held tracked file: the local copy is set aside and the sync keeps moving', async () => {
    const key = fake.github();
    await writeFile('notes/shared.md', `v1 local\n${key}\n`);
    await commitIfDirty();
    run('git rm -q notes/shared.md && git commit -q -m "deleted there" && git push -q origin main', cloneDir);
    await writeFile('notes/later.md', 'later\n', cloneDir);
    run('git add -A && git commit -q -m later && git push -q origin main', cloneDir);

    await sync();

    expect(fs.existsSync(path.join(repo, 'notes/shared.md'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'notes/later.md'), 'utf-8')).toBe('later\n');
    const aside = fs.readdirSync(path.join(repo, 'notes')).filter((f) => f.startsWith('shared.md.conflicted-secret-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, 'notes', aside[0]), 'utf-8')).toContain(key);
    expect(run('git log -p --all', bareDir)).not.toContain(key);
  }, 60_000);

  it('the other box adding a file at a held new path: set aside, never silently overwritten', async () => {
    const key = fake.github();
    await writeFile('memory/daily/2026-10-27.md', `mine ${key}\n`);
    await commitIfDirty();
    await writeFile('memory/daily/2026-10-27.md', 'theirs\n', cloneDir);
    run('git add -A && git commit -q -m theirs && git push -q origin main', cloneDir);

    await sync();

    expect(fs.readFileSync(path.join(repo, 'memory/daily/2026-10-27.md'), 'utf-8')).toBe('theirs\n');
    const aside = fs.readdirSync(path.join(repo, 'memory/daily')).filter((f) => f.includes('.conflicted-secret-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, 'memory/daily', aside[0]), 'utf-8')).toContain(key);
    expect(run('git log -p --all', bareDir)).not.toContain(key);
  }, 60_000);
});
