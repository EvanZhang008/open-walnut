/**
 * Unit tests for plugin sources ("plugin store") — src/core/plugin-sources.ts.
 *
 * Uses real local git repos (file:// URLs) in the temp WALNUT_HOME so the
 * clone/pull/scan paths are exercised end-to-end with zero network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-sources-test'));

// In-memory config store — plugin-sources reads/writes plugin_sources through it
let mockConfig: Record<string, unknown> = {};
let configWriteError: Error | null = null;
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => mockConfig),
  updateConfig: vi.fn(async (partial: Record<string, unknown>) => {
    if (configWriteError) throw configWriteError;
    mockConfig = { ...mockConfig, ...partial };
  }),
}));

import { WALNUT_HOME, PLUGIN_STORES_DIR } from '../../src/constants.js';
import {
  addSource, addNpmSource, updateSource, checkSource, removeSource, listSources,
  scanStorePlugins, getStorePluginDirs,
  slugForUrl, slugForSource, isValidSourceUrl, maskSourceUrl, isValidSlug, isValidSourceRef,
  parseShareSnippet, buildShareSnippet,
} from '../../src/core/plugin-sources.js';
import { setNpmRunner, type NpmRunner } from '../../src/core/plugin-npm-install.js';

let fixtureRoot: string;

/** Create a git repo at dir with the given files committed. Returns file:// URL. */
function makeGitRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(fixtureRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name Test');
  git('add -A');
  git('commit -q -m init');
  return `file://${dir}`;
}

function commitFile(repoUrl: string, rel: string, content: string): void {
  const dir = repoUrl.replace('file://', '');
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execSync('git add -A && git commit -q -m update', { cwd: dir, stdio: 'pipe' });
}

const MANIFEST = (id: string, extra = '') =>
  `{ "id": "${id}", "name": "${id} plugin"${extra} }`;

// ── Fake npm registry (no network; see tests/core/plugin-npm-install.test.ts
// for the installer's own argv/verification coverage) ──

interface FakeNpmPackage {
  version: string;
  integrity?: string;
  receiptIntegrity?: string;
  files?: Record<string, string>;
}

let npmRegistry: Record<string, FakeNpmPackage> = {};
let npmCalls: string[][] = [];

function npmNameOf(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? spec : spec.slice(0, at);
}

const fakeNpmRunner: NpmRunner = async (args) => {
  npmCalls.push([...args]);
  const isView = args[0] === 'view';
  const spec = isView ? args[args.indexOf('--') + 1] : args[args.length - 1];
  const name = npmNameOf(spec);
  const pkg = npmRegistry[name];
  if (!pkg) throw new Error(`404 Not Found - ${name}`);

  if (isView) {
    return {
      stdout: JSON.stringify({
        name,
        version: pkg.version,
        ...(pkg.integrity ? { 'dist.integrity': pkg.integrity } : {}),
        'dist.tarball': `https://registry.example/${name}.tgz`,
      }),
      stderr: '',
    };
  }

  const prefix = args[args.indexOf('--prefix') + 1];
  const target = path.join(prefix, 'node_modules', ...name.split('/'));
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version: pkg.version }));
  for (const [rel, content] of Object.entries(pkg.files ?? {})) {
    const abs = path.join(target, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  const rootKey = path.relative(prefix, target).replaceAll(path.sep, '/');
  await fsp.writeFile(path.join(prefix, 'node_modules', '.package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      [rootKey]: {
        version: pkg.version,
        resolved: `https://registry.example/${name}.tgz`,
        integrity: pkg.receiptIntegrity ?? pkg.integrity ?? 'sha512-FAKE==',
      },
    },
  }));
  return { stdout: 'added 1 package', stderr: '' };
};

beforeEach(async () => {
  mockConfig = {};
  configWriteError = null;
  npmRegistry = {};
  npmCalls = [];
  setNpmRunner(fakeNpmRunner);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  fixtureRoot = path.join(WALNUT_HOME, 'fixtures');
  await fsp.mkdir(fixtureRoot, { recursive: true });
});

afterEach(async () => {
  setNpmRunner(null);
  await fsp.rm(WALNUT_HOME, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 25,
  });
});

describe('URL helpers', () => {
  it('validates URLs', () => {
    expect(isValidSourceUrl('https://github.com/a/b.git')).toBe(true);
    expect(isValidSourceUrl('git@host.com:team/repo.git')).toBe(true);
    expect(isValidSourceUrl('ssh://git@host/repo.git')).toBe(true);
    expect(isValidSourceUrl('file:///tmp/x')).toBe(true);
    expect(isValidSourceUrl('https://h/a.git; rm -rf /')).toBe(false);
    expect(isValidSourceUrl('https://h/$(whoami)')).toBe(false);
    expect(isValidSourceUrl('not-a-url')).toBe(false);
  });

  it('masks embedded credentials', () => {
    expect(maskSourceUrl('https://user:tok123@host/r.git')).toBe('https://***@host/r.git');
    expect(maskSourceUrl('https://host/r.git')).toBe('https://host/r.git');
    expect(maskSourceUrl('git@host:r.git')).toBe('git@host:r.git');
  });

  it('derives slugs', () => {
    expect(slugForUrl('https://github.com/a/My-Plugins.git')).toBe('my-plugins');
    expect(slugForUrl('git@host:team/store.git')).toBe('store');
    expect(slugForUrl('file:///tmp/repo/')).toBe('repo');
  });

  it('rejects traversal and internal slugs', () => {
    expect(isValidSlug('ok-slug')).toBe(true);
    expect(isValidSlug('../evil')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('.')).toBe(false);
    expect(isValidSlug('.staging-source')).toBe(false);
    expect(isValidSlug('.backup-source')).toBe(false);
  });

  it('accepts ordinary refs and rejects shell or traversal syntax', () => {
    expect(isValidSourceRef('main')).toBe(true);
    expect(isValidSourceRef('release/1.2.3')).toBe(true);
    expect(isValidSourceRef('feature_name-2')).toBe(true);
    for (const ref of [
      'main; touch /tmp/pwned',
      '$(touch /tmp/pwned)',
      '`touch /tmp/pwned`',
      '--upload-pack=evil',
      '../main',
      'feature//part',
      '.hidden',
      'topic.lock',
    ]) {
      expect(isValidSourceRef(ref), ref).toBe(false);
    }
  });
});

describe('scanStorePlugins', () => {
  it('finds a root-level plugin', async () => {
    const url = makeGitRepo('single', { 'manifest.json': MANIFEST('solo') });
    const dir = url.replace('file://', '');
    const found = await scanStorePlugins(dir);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('solo');
  });

  it('finds plugins one level deep', async () => {
    const url = makeGitRepo('multi', {
      'alpha/manifest.json': MANIFEST('alpha'),
      'beta/manifest.json': MANIFEST('beta'),
      'not-a-plugin/readme.md': 'hi',
    });
    const found = await scanStorePlugins(url.replace('file://', ''));
    expect(found.map(p => p.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('reports invalid manifests without throwing', async () => {
    const url = makeGitRepo('broken', { 'bad/manifest.json': '{not json' });
    const found = await scanStorePlugins(url.replace('file://', ''));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBeNull();
    expect(found[0].error).toContain('invalid manifest.json');
  });
});

describe('source lifecycle', () => {
  it('addSource clones and registers in config', async () => {
    const url = makeGitRepo('store-a', { 'alpha/manifest.json': MANIFEST('alpha') });
    const view = await addSource(url);
    expect(view.slug).toBe('store-a');
    expect(view.cloned).toBe(true);
    expect(view.lastSha).toBeTruthy();
    expect(view.plugins.map(p => p.id)).toEqual(['alpha']);
    expect((mockConfig.plugin_sources as unknown[])).toHaveLength(1);
    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'store-a', 'alpha', 'manifest.json'))).toBe(true);
  });

  it('rejects duplicate source URLs', async () => {
    const url = makeGitRepo('store-dup', { 'manifest.json': MANIFEST('d') });
    await addSource(url);
    await expect(addSource(url)).rejects.toThrow('already added');
  });

  it('rejects invalid URLs and refs without touching the store', async () => {
    await expect(addSource('https://h/x.git; echo pwn')).rejects.toThrow('Invalid git URL');
    await expect(addSource('https://host.example/repo.git', 'main; touch /tmp/pwned'))
      .rejects.toThrow('Invalid git ref');
    expect(fs.existsSync(PLUGIN_STORES_DIR)).toBe(false);
  });

  it('clones an explicitly selected branch without a shell', async () => {
    const url = makeGitRepo('store-ref', { 'manifest.json': MANIFEST('ref') });
    const view = await addSource(url, 'main');
    expect(view.ref).toBe('main');
    expect(view.plugins.map((plugin) => plugin.id)).toEqual(['ref']);
  });

  it('serializes same-slug clones so a loser cannot delete the winner', async () => {
    const first = makeGitRepo('one/shared-store', { 'manifest.json': MANIFEST('first') });
    const second = makeGitRepo('two/shared-store', { 'manifest.json': MANIFEST('second') });
    const results = await Promise.allSettled([addSource(first), addSource(second)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((mockConfig.plugin_sources as unknown[])).toHaveLength(1);
    const installed = await scanStorePlugins(path.join(PLUGIN_STORES_DIR, 'shared-store'));
    expect(installed).toHaveLength(1);
    expect(['first', 'second']).toContain(installed[0].id);
  });

  it('preserves concurrent additions to config and state', async () => {
    const first = makeGitRepo('concurrent-a', { 'manifest.json': MANIFEST('a') });
    const second = makeGitRepo('concurrent-b', { 'manifest.json': MANIFEST('b') });
    await Promise.all([addSource(first), addSource(second)]);

    expect((mockConfig.plugin_sources as Array<{ url: string }>).map((source) => source.url).sort())
      .toEqual([first, second].sort());
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf8'));
    expect(Object.keys(state).sort()).toEqual(['concurrent-a', 'concurrent-b']);
  });

  it('never removes the store root or an unconfigured directory', async () => {
    const orphan = path.join(PLUGIN_STORES_DIR, 'orphan');
    await fsp.mkdir(orphan, { recursive: true });
    await fsp.writeFile(path.join(orphan, 'keep.txt'), 'keep');

    await expect(removeSource('.')).rejects.toThrow('Invalid source slug');
    await expect(removeSource('orphan')).rejects.toThrow('was not found');
    expect(fs.readFileSync(path.join(orphan, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rolls back a Git tree and state row when config persistence fails', async () => {
    const url = makeGitRepo('store-config-fail', { 'manifest.json': MANIFEST('rollback') });
    configWriteError = new Error('config is read-only');

    await expect(addSource(url)).rejects.toThrow('config is read-only');
    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'store-config-fail'))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf8'));
    expect(state['store-config-fail']).toBeUndefined();
    expect(mockConfig.plugin_sources).toBeUndefined();
  });

  it('updateSource pulls new plugins', async () => {
    const url = makeGitRepo('store-up', { 'alpha/manifest.json': MANIFEST('alpha') });
    await addSource(url);
    commitFile(url, 'beta/manifest.json', MANIFEST('beta'));

    const result = await updateSource('store-up');
    expect(result.error).toBeUndefined();
    expect(result.updated).toBe(true);
    expect(result.fromSha).not.toBe(result.toSha);

    const dirs = await getStorePluginDirs();
    expect(dirs.some(d => d.endsWith('/beta'))).toBe(true);
  });

  it('updateSource restores a configured Git source missing on this machine', async () => {
    const url = makeGitRepo('store-restore', { 'manifest.json': MANIFEST('restored') });
    await addSource(url);
    await fsp.rm(path.join(PLUGIN_STORES_DIR, 'store-restore'), { recursive: true, force: true });

    const result = await updateSource('store-restore');

    expect(result.updated).toBe(true);
    expect(result.fromSha).toBeUndefined();
    expect((await getStorePluginDirs()).some((dir) => dir.endsWith('/store-restore'))).toBe(true);
  });

  it('updateSource records error instead of throwing', async () => {
    const url = makeGitRepo('store-err', { 'manifest.json': MANIFEST('e') });
    await addSource(url);
    // Break the remote so pull fails
    await fsp.rm(url.replace('file://', ''), { recursive: true, force: true });
    const result = await updateSource('store-err');
    expect(result.updated).toBe(false);
    expect(result.error).toBeTruthy();
    const [view] = await listSources();
    expect(view.lastError).toBeTruthy();
  });

  it('never lets a non-checkout source walk up into the data repository', async () => {
    execSync('git init -q -b main', { cwd: WALNUT_HOME, stdio: 'pipe' });
    execSync('git config user.email test@example.com && git config user.name Test', { cwd: WALNUT_HOME, stdio: 'pipe' });
    await fsp.writeFile(path.join(WALNUT_HOME, 'root.txt'), 'root');
    execSync('git add root.txt && git commit -q -m root', { cwd: WALNUT_HOME, stdio: 'pipe' });
    const before = execSync('git rev-parse HEAD', { cwd: WALNUT_HOME, encoding: 'utf8' }).trim();
    mockConfig.plugin_sources = [{ url: 'https://example.test/not-checkout.git', enabled: true }];
    await fsp.mkdir(path.join(PLUGIN_STORES_DIR, 'not-checkout'), { recursive: true });

    const result = await updateSource('not-checkout');

    expect(result).toMatchObject({ updated: false, error: 'Source directory is not a git checkout.' });
    expect(execSync('git rev-parse HEAD', { cwd: WALNUT_HOME, encoding: 'utf8' }).trim()).toBe(before);
  });

  it('removeSource deletes clone and config entry', async () => {
    const url = makeGitRepo('store-rm', { 'manifest.json': MANIFEST('r') });
    await addSource(url);
    await removeSource('store-rm');
    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'store-rm'))).toBe(false);
    expect((mockConfig.plugin_sources as unknown[])).toHaveLength(0);
    expect(await listSources()).toHaveLength(0);
  });

  it('getStorePluginDirs skips disabled sources', async () => {
    const url = makeGitRepo('store-off', { 'alpha/manifest.json': MANIFEST('alpha') });
    await addSource(url);
    expect(await getStorePluginDirs()).toHaveLength(1);
    mockConfig.plugin_sources = [{ url, enabled: false }];
    expect(await getStorePluginDirs()).toHaveLength(0);
  });

  it('listSources masks credentials in URLs', async () => {
    // Seed config directly (no clone needed for the masking path)
    mockConfig.plugin_sources = [{ url: 'https://me:secret@host/repo.git', enabled: true }];
    const [view] = await listSources();
    expect(view.url).toBe('https://***@host/repo.git');
    expect(view.url).not.toContain('secret');
    // Credential-bearing URLs must never produce a share snippet
    expect(view.shareSnippet).toBeUndefined();
  });

  it('addSource self-heals the data-repo .gitignore (nested-repo protection)', async () => {
    // Make WALNUT_HOME a git repo like the real data dir (git-sync auto-commits it)
    execSync('git init -q -b main', { cwd: WALNUT_HOME, stdio: 'pipe' });
    const url = makeGitRepo('store-ign', { 'manifest.json': MANIFEST('i') });
    await addSource(url);

    const ignore = fs.readFileSync(path.join(WALNUT_HOME, '.gitignore'), 'utf-8');
    expect(ignore).toContain('plugin-stores/');
    // The nested clone must be invisible to the outer repo
    const check = execSync('git check-ignore plugin-stores/store-ign || true', {
      cwd: WALNUT_HOME, stdio: 'pipe', shell: '/bin/bash',
    }).toString();
    expect(check).toContain('plugin-stores');
  });
});

describe('share snippets', () => {
  it('round-trips build → parse', () => {
    const snippet = buildShareSnippet('git@host:team/plugins.git');
    expect(parseShareSnippet(snippet)).toEqual({ url: 'git@host:team/plugins.git' });

    const withRef = buildShareSnippet('https://host/r.git', 'release');
    expect(parseShareSnippet(withRef)).toEqual({ url: 'https://host/r.git', ref: 'release' });
  });

  it('accepts the string shorthand form', () => {
    expect(parseShareSnippet('{"walnut_plugin_source": "https://host/r.git"}'))
      .toEqual({ url: 'https://host/r.git' });
  });

  it('returns null for plain URLs and junk', () => {
    expect(parseShareSnippet('https://github.com/a/b.git')).toBeNull();
    expect(parseShareSnippet('{not json')).toBeNull();
    expect(parseShareSnippet('{"other_key": "x"}')).toBeNull();
  });

  it('pasted snippet installs a source end-to-end (via addSource path)', async () => {
    const url = makeGitRepo('store-snip', { 'manifest.json': MANIFEST('snip') });
    const snippet = buildShareSnippet(url);
    const parsed = parseShareSnippet(snippet)!;
    const view = await addSource(parsed.url, parsed.ref);
    expect(view.slug).toBe('store-snip');
    expect(view.plugins[0].id).toBe('snip');
    // And the installed source exposes a snippet for re-sharing
    expect(view.shareSnippet).toContain('walnut_plugin_source');
  });
});

describe('npm source lifecycle', () => {
  const NPM_MANIFEST = MANIFEST('npm-plug');

  it('addNpmSource installs, records resolved + integrity, and registers only the spec', async () => {
    npmRegistry['walnut-plugin-demo'] = {
      version: '1.2.0',
      integrity: 'sha512-DEMO==',
      files: { 'manifest.json': NPM_MANIFEST },
    };

    const view = await addNpmSource('walnut-plugin-demo@latest');

    expect(view.slug).toBe('npm-walnut-plugin-demo');
    expect(view.kind).toBe('npm');
    expect(view.type).toBe('npm');
    expect(view.spec).toBe('walnut-plugin-demo@latest');
    expect(view.resolved).toBe('walnut-plugin-demo@1.2.0');
    expect(view.version).toBe('1.2.0');
    expect(view.integrity).toBe('sha512-DEMO==');
    expect(view.cloned).toBe(true);
    expect(view.plugins.map(p => p.id)).toEqual(['npm-plug']);
    // The spec is what the user consented to; the resolved version is runtime state.
    expect(mockConfig.plugin_sources).toEqual([
      { type: 'npm', spec: 'walnut-plugin-demo@latest', enabled: true },
    ]);

    // Lifecycle scripts are never run, and the pinned version is what npm gets.
    const install = npmCalls.find(c => c[0] === 'install')!;
    expect(install).toContain('--ignore-scripts');
    expect(install[install.length - 1]).toBe('walnut-plugin-demo@1.2.0');

    // Persisted state survives a reload of the view.
    const [reloaded] = await listSources();
    expect(reloaded).toMatchObject({
      slug: 'npm-walnut-plugin-demo',
      kind: 'npm',
      resolved: 'walnut-plugin-demo@1.2.0',
      integrity: 'sha512-DEMO==',
      packageName: 'walnut-plugin-demo',
    });
    expect(reloaded.shareSnippet).toBeUndefined(); // npm sources have no snippet
    expect(reloaded.url).toBeUndefined();

    const stateFile = path.join(PLUGIN_STORES_DIR, 'sources.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state['npm-walnut-plugin-demo']).toMatchObject({
      type: 'npm',
      spec: 'walnut-plugin-demo@latest',
      resolved: 'walnut-plugin-demo@1.2.0',
      integrity: 'sha512-DEMO==',
    });
  });

  it('records integrity from npm installed-tree receipt when metadata omits it', async () => {
    npmRegistry['walnut-plugin-receipt'] = {
      version: '1.0.0',
      receiptIntegrity: 'sha512-RECEIPT==',
      files: { 'manifest.json': NPM_MANIFEST },
    };

    const view = await addNpmSource('walnut-plugin-receipt');

    expect(view.integrity).toBe('sha512-RECEIPT==');
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf8'));
    expect(state['npm-walnut-plugin-receipt'].integrity).toBe('sha512-RECEIPT==');
  });

  it('rolls back an npm tree and state row when config persistence fails', async () => {
    npmRegistry['walnut-plugin-config-fail'] = {
      version: '1.0.0',
      integrity: 'sha512-ROLLBACK==',
      files: { 'manifest.json': NPM_MANIFEST },
    };
    configWriteError = new Error('config is read-only');

    await expect(addNpmSource('walnut-plugin-config-fail')).rejects.toThrow('config is read-only');
    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-config-fail'))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf8'));
    expect(state['npm-walnut-plugin-config-fail']).toBeUndefined();
    expect(mockConfig.plugin_sources).toBeUndefined();
  });

  it('rejects an invalid spec before touching disk or npm', async () => {
    await expect(addNpmSource('git+https://host/repo.git')).rejects.toThrow('Invalid npm package spec');
    expect(npmCalls).toHaveLength(0);
    expect(fs.existsSync(PLUGIN_STORES_DIR)).toBe(false);
  });

  it('rejects a duplicate package even when a different version is typed', async () => {
    npmRegistry['walnut-plugin-dup'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('dup') } };
    await addNpmSource('walnut-plugin-dup');
    await expect(addNpmSource('walnut-plugin-dup@1.0.0')).rejects.toThrow('already added');
    expect((mockConfig.plugin_sources as unknown[])).toHaveLength(1);
  });

  it('leaves nothing behind when the package has no root manifest.json', async () => {
    npmRegistry['walnut-plugin-bare'] = { version: '1.0.0', files: { 'index.js': '// no manifest' } };
    await expect(addNpmSource('walnut-plugin-bare')).rejects.toThrow('not a Walnut plugin');

    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-bare'))).toBe(false);
    expect(fs.readdirSync(PLUGIN_STORES_DIR).filter(n => n.startsWith('.staging-'))).toEqual([]);
    expect(mockConfig.plugin_sources).toBeUndefined();
  });

  it('an npm slug never collides with a git slug for the same name', async () => {
    npmRegistry['store-both'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('npm-both') } };
    const url = makeGitRepo('store-both', { 'manifest.json': MANIFEST('git-both') });
    await addSource(url);
    await addNpmSource('store-both');

    const sources = await listSources();
    expect(sources.map(s => s.slug).sort()).toEqual(['npm-store-both', 'store-both']);
    expect(await getStorePluginDirs()).toHaveLength(2);
    expect(slugForSource({ url })).toBe('store-both');
    expect(slugForSource({ type: 'npm', spec: 'store-both' })).toBe('npm-store-both');
  });

  it('never auto-updates: a moved tag only lands on an explicit update', async () => {
    npmRegistry['walnut-plugin-tag'] = { version: '1.0.0', files: { 'manifest.json': NPM_MANIFEST, 'v.txt': 'one' } };
    await addNpmSource('walnut-plugin-tag@latest');

    // Registry moves on; listing and dir discovery must NOT re-resolve.
    npmRegistry['walnut-plugin-tag'] = { version: '2.0.0', files: { 'manifest.json': NPM_MANIFEST, 'v.txt': 'two' } };
    npmCalls = [];
    await listSources();
    await getStorePluginDirs();
    expect(npmCalls).toHaveLength(0);
    const installed = path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-tag', 'v.txt');
    expect(fs.readFileSync(installed, 'utf-8')).toBe('one');

    // check() reports it without changing anything.
    const check = await checkSource('npm-walnut-plugin-tag');
    expect(check).toMatchObject({ behind: 1, updateAvailable: true, resolved: 'walnut-plugin-tag@2.0.0' });
    expect(fs.readFileSync(installed, 'utf-8')).toBe('one');

    // Explicit update swaps it in.
    const result = await updateSource('npm-walnut-plugin-tag');
    expect(result).toMatchObject({
      updated: true, fromResolved: 'walnut-plugin-tag@1.0.0', resolved: 'walnut-plugin-tag@2.0.0',
    });
    expect(fs.readFileSync(installed, 'utf-8')).toBe('two');
    const [view] = await listSources();
    expect(view.resolved).toBe('walnut-plugin-tag@2.0.0');
    expect(view.version).toBe('2.0.0');
  });

  it('updateSource is a no-op when the resolved version and integrity are unchanged', async () => {
    npmRegistry['walnut-plugin-same'] = {
      version: '1.0.0', integrity: 'sha512-SAME==', files: { 'manifest.json': NPM_MANIFEST },
    };
    await addNpmSource('walnut-plugin-same');
    npmCalls = [];

    const result = await updateSource('npm-walnut-plugin-same');
    expect(result).toMatchObject({ updated: false, resolved: 'walnut-plugin-same@1.0.0' });
    expect(result.error).toBeUndefined();
    // Only the resolve ran — no download, no swap.
    expect(npmCalls.map(c => c[0])).toEqual(['view']);
    expect(await checkSource('npm-walnut-plugin-same')).toMatchObject({ behind: 0, updateAvailable: false });
  });

  it('reinstalls when the version is unchanged but the integrity moved', async () => {
    npmRegistry['walnut-plugin-retag'] = {
      version: '1.0.0', integrity: 'sha512-AAAA==', files: { 'manifest.json': NPM_MANIFEST, 'v.txt': 'first' },
    };
    await addNpmSource('walnut-plugin-retag');
    // Same version number, different bytes — a republished tarball must not be trusted.
    npmRegistry['walnut-plugin-retag'] = {
      version: '1.0.0', integrity: 'sha512-BBBB==', files: { 'manifest.json': NPM_MANIFEST, 'v.txt': 'second' },
    };

    expect(await checkSource('npm-walnut-plugin-retag')).toMatchObject({
      behind: 1,
      updateAvailable: true,
      resolved: 'walnut-plugin-retag@1.0.0',
    });
    const result = await updateSource('npm-walnut-plugin-retag');
    expect(result).toMatchObject({ updated: true, integrity: 'sha512-BBBB==' });
    expect(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-retag', 'v.txt'), 'utf-8')).toBe('second');
  });

  it('updateSource records the error instead of throwing, and keeps the old code', async () => {
    npmRegistry['walnut-plugin-gone'] = { version: '1.0.0', files: { 'manifest.json': NPM_MANIFEST, 'v.txt': 'old' } };
    await addNpmSource('walnut-plugin-gone');
    delete npmRegistry['walnut-plugin-gone']; // unpublished / registry down

    const result = await updateSource('npm-walnut-plugin-gone');
    expect(result.updated).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-gone', 'v.txt'), 'utf-8')).toBe('old');
    const [view] = await listSources();
    expect(view.lastError).toBeTruthy();
    expect(view.resolved).toBe('walnut-plugin-gone@1.0.0');
  });

  it('removeSource deletes the package dir, config entry and state', async () => {
    npmRegistry['walnut-plugin-rm'] = { version: '1.0.0', files: { 'manifest.json': NPM_MANIFEST } };
    await addNpmSource('walnut-plugin-rm');
    expect(await getStorePluginDirs()).toHaveLength(1);

    await removeSource('npm-walnut-plugin-rm');
    expect(fs.existsSync(path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-rm'))).toBe(false);
    expect((mockConfig.plugin_sources as unknown[])).toHaveLength(0);
    expect(await listSources()).toHaveLength(0);
    expect(await getStorePluginDirs()).toHaveLength(0);
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf-8'));
    expect(state['npm-walnut-plugin-rm']).toBeUndefined();
  });

  it('getStorePluginDirs skips a disabled npm source and ignores node_modules', async () => {
    npmRegistry['walnut-plugin-off'] = { version: '1.0.0', files: { 'manifest.json': NPM_MANIFEST } };
    await addNpmSource('walnut-plugin-off');
    // A dependency with its own manifest must never be discovered as a plugin.
    const depDir = path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-off', 'node_modules', 'sneaky');
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, 'manifest.json'), MANIFEST('sneaky'));
    expect(await getStorePluginDirs()).toEqual([path.join(PLUGIN_STORES_DIR, 'npm-walnut-plugin-off')]);

    mockConfig.plugin_sources = [{ type: 'npm', spec: 'walnut-plugin-off', enabled: false }];
    expect(await getStorePluginDirs()).toHaveLength(0);
  });

  it('a legacy git-only config keeps working alongside npm entries', async () => {
    npmRegistry['walnut-plugin-mix'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('mix-npm') } };
    const url = makeGitRepo('store-mix', { 'alpha/manifest.json': MANIFEST('mix-git') });
    await addSource(url);          // legacy shape: {url, enabled}
    await addNpmSource('walnut-plugin-mix');

    const sources = await listSources();
    const git = sources.find(s => s.slug === 'store-mix')!;
    const npm = sources.find(s => s.slug === 'npm-walnut-plugin-mix')!;
    expect(git.kind).toBe('git');
    expect(git.url).toBe(url);
    expect(git.lastSha).toBeTruthy();
    expect(git.shareSnippet).toContain('walnut_plugin_source');
    expect(git.type).toBeUndefined();
    expect(npm.kind).toBe('npm');
    expect(npm.lastSha).toBeUndefined();
    // Updating the git source must not disturb the npm one.
    commitFile(url, 'beta/manifest.json', MANIFEST('mix-git-2'));
    const result = await updateSource('store-mix');
    expect(result.updated).toBe(true);
    expect(result.fromSha).not.toBe(result.toSha);
    expect((await listSources()).find(s => s.slug === 'npm-walnut-plugin-mix')?.resolved)
      .toBe('walnut-plugin-mix@1.0.0');
  });
});
