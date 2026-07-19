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
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => mockConfig),
  updateConfig: vi.fn(async (partial: Record<string, unknown>) => {
    mockConfig = { ...mockConfig, ...partial };
  }),
}));

import { WALNUT_HOME, PLUGIN_STORES_DIR } from '../../src/constants.js';
import {
  addSource, updateSource, removeSource, listSources,
  scanStorePlugins, getStorePluginDirs,
  slugForUrl, isValidSourceUrl, maskSourceUrl, isValidSlug,
  parseShareSnippet, buildShareSnippet,
} from '../../src/core/plugin-sources.js';

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

beforeEach(async () => {
  mockConfig = {};
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  fixtureRoot = path.join(WALNUT_HOME, 'fixtures');
  await fsp.mkdir(fixtureRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
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

  it('rejects traversal slugs', () => {
    expect(isValidSlug('ok-slug')).toBe(true);
    expect(isValidSlug('../evil')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
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

  it('rejects invalid URLs without touching disk', async () => {
    await expect(addSource('https://h/x.git; echo pwn')).rejects.toThrow('Invalid git URL');
    expect(fs.existsSync(PLUGIN_STORES_DIR)).toBe(false);
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
