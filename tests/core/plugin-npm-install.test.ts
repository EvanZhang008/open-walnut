/**
 * Unit tests for the npm plugin installer — src/core/plugin-npm-install.ts.
 *
 * Zero network: every bun package-manager call (`bun info`, `bun add`) goes
 * through the injected runner seam, so the tests assert the exact argv Walnut
 * would hand to bun (notably `--ignore-scripts`) and then materialize the tree
 * and bun.lock a hoisted `bun add` leaves, to exercise the verification,
 * dependency placement and atomic-placement path for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseNpmSpec, isValidNpmSpec, slugForNpmPackage, sanitizeNpmOutput, parseBunLock,
  resolveNpmSpec, installNpmPlugin, replaceNpmPlugin, setNpmRunner,
  type NpmRunner,
} from '../../src/core/plugin-npm-install.js';

// ── Fake registry + runner ──

interface FakePackage {
  version: string;
  integrity?: string;
  /** Files written into the installed package dir (relative paths). */
  files?: Record<string, string>;
  /** Materialize the package path as a symlink instead of a real directory. */
  symlinkTo?: string;
  /** Materialize the package path as a plain file. */
  asFile?: boolean;
  /** Materialize node_modules itself as a symlink to this dir. */
  modulesSymlinkTo?: string;
  /** Lie in package.json (drifted tarball vs. registry metadata). */
  packageJsonName?: string;
  packageJsonVersion?: string;
  receiptIntegrity?: string;
  /** The receipt's tarball field (default: the advertised URL; bun writes "" for registry.npmjs.org). */
  receiptResolved?: string;
  /** The registry origin `bun info` advertises tarballs on (default https://registry.example). */
  registryOrigin?: string;
  /** Materialize the plugin's own node_modules as a symlink to this dir. */
  ownModulesSymlinkTo?: string;
  /** The receipt's ident (default `name@version`). */
  receiptIdent?: string;
  omitReceipt?: boolean;
  omitReceiptRoot?: boolean;
  /** The receipt entry in the shape bun writes for a non-registry source: no tarball field. */
  receiptNotRegistry?: boolean;
  /** Extra dependencies bun hoisted beside the plugin (name -> files). */
  hoisted?: Record<string, Record<string, string>>;
  /** Dependencies bun nested inside the plugin itself (a version clash with a hoisted one). */
  nested?: Record<string, Record<string, string>>;
}

let registryFixtures: Record<string, FakePackage> = {};
let npmCalls: string[][] = [];
let tmpRoot = '';

const MANIFEST = (id: string) => JSON.stringify({ id, name: `${id} plugin`, version: '1.0.0' });

/** Split `@scope/name@1.2.3` into its package name. */
function nameOf(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? spec : spec.slice(0, at);
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

const fakeRunner: NpmRunner = async (args, opts) => {
  npmCalls.push([...args]);

  if (args[0] === 'info') {
    const spec = args[args.indexOf('--') + 1];
    const name = nameOf(spec);
    const pkg = registryFixtures[name];
    if (!pkg) throw new Error(`404 Not Found: https://registry.example/${name}`);
    return {
      stdout: JSON.stringify({
        name,
        version: pkg.version,
        ...(pkg.integrity ? { 'dist.integrity': pkg.integrity } : {}),
        'dist.tarball': `${pkg.registryOrigin ?? 'https://registry.example'}/${name}/-/${name}-${pkg.version}.tgz`,
      }),
      stderr: '',
    };
  }

  if (args[0] === 'add') {
    // `bun add` installs into its cwd: the staging dir with its own package.json.
    const prefix = opts.cwd;
    const spec = args[args.length - 1];
    const name = nameOf(spec);
    const pkg = registryFixtures[name];
    if (!pkg) throw new Error(`404 Not Found - ${name}`);

    const modulesDir = path.join(prefix, 'node_modules');
    if (pkg.modulesSymlinkTo) {
      await fsp.mkdir(pkg.modulesSymlinkTo, { recursive: true });
      await fsp.symlink(pkg.modulesSymlinkTo, modulesDir, 'dir');
    } else {
      await fsp.mkdir(modulesDir, { recursive: true });
    }
    const target = path.join(modulesDir, ...name.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (pkg.symlinkTo) {
      await fsp.mkdir(pkg.symlinkTo, { recursive: true });
      await fsp.symlink(pkg.symlinkTo, target, 'dir');
      return { stdout: 'installed 1 package', stderr: '' };
    }
    if (pkg.asFile) {
      await fsp.writeFile(target, 'not a directory');
      return { stdout: 'installed 1 package', stderr: '' };
    }

    await writeTree(target, {
      'package.json': JSON.stringify({ name: pkg.packageJsonName ?? name, version: pkg.packageJsonVersion ?? pkg.version }),
      ...pkg.files,
    });
    // bun's hoisted layout: the plugin's dependencies sit beside it, links to bins in .bin.
    const hoisted = pkg.hoisted ?? { 'left-pad': { 'index.js': '// dep' } };
    for (const [dep, files] of Object.entries(hoisted)) await writeTree(path.join(modulesDir, ...dep.split('/')), files);
    await fsp.mkdir(path.join(modulesDir, '.bin'), { recursive: true });
    if (pkg.ownModulesSymlinkTo) {
      await fsp.mkdir(pkg.ownModulesSymlinkTo, { recursive: true });
      await fsp.symlink(pkg.ownModulesSymlinkTo, path.join(target, 'node_modules'), 'dir');
    }
    for (const [dep, files] of Object.entries(pkg.nested ?? {})) await writeTree(path.join(target, 'node_modules', dep), files);

    const packages: Record<string, unknown[]> = {};
    if (!pkg.omitReceiptRoot) {
      const ident = pkg.receiptIdent ?? `${name}@${pkg.version}`;
      const integrity = pkg.receiptIntegrity ?? pkg.integrity ?? 'sha512-FAKE==';
      packages[name] = pkg.receiptNotRegistry
        ? [ident, {}, integrity]
        : [ident, pkg.receiptResolved ?? `${pkg.registryOrigin ?? 'https://registry.example'}/${name}/-/${name}-${pkg.version}.tgz`, {}, integrity];
    }
    for (const dep of Object.keys(hoisted)) packages[dep] = [`${dep}@1.0.0`, '', {}, 'sha512-LEFTPAD=='];
    if (!pkg.omitReceipt) {
      // As bun writes it: trailing commas.
      const body = Object.entries(packages).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n\n');
      await fsp.writeFile(path.join(prefix, 'bun.lock'), `{\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "packages": {\n${body}\n  }\n}\n`);
    }
    return { stdout: 'installed', stderr: '' };
  }

  throw new Error(`unexpected bun command: ${args[0]}`);
};

beforeEach(async () => {
  registryFixtures = {};
  npmCalls = [];
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-npm-install-'));
  setNpmRunner(fakeRunner);
});

afterEach(async () => {
  setNpmRunner(null);
  vi.restoreAllMocks();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function stagingRoot(): string {
  return path.join(tmpRoot, 'plugin-stores');
}

/** Staging/backup dirs this module creates are dotted; none may survive a call. */
async function leftoverTempDirs(): Promise<string[]> {
  const entries = await fsp.readdir(stagingRoot(), { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.name.startsWith('.staging-') || e.name.startsWith('.backup-')).map(e => e.name);
}

// ── Spec validation ──

describe('parseNpmSpec', () => {
  it('accepts the four registry forms', () => {
    expect(parseNpmSpec('walnut-plugin')).toEqual({ name: 'walnut-plugin', spec: 'walnut-plugin' });
    expect(parseNpmSpec('walnut-plugin@1.2.3'))
      .toEqual({ name: 'walnut-plugin', requested: '1.2.3', spec: 'walnut-plugin@1.2.3' });
    expect(parseNpmSpec('walnut-plugin@next'))
      .toEqual({ name: 'walnut-plugin', requested: 'next', spec: 'walnut-plugin@next' });
    expect(parseNpmSpec('@acme/walnut-plugin'))
      .toEqual({ name: '@acme/walnut-plugin', spec: '@acme/walnut-plugin' });
    expect(parseNpmSpec('@acme/walnut-plugin@0.1.0-rc.2'))
      .toEqual({ name: '@acme/walnut-plugin', requested: '0.1.0-rc.2', spec: '@acme/walnut-plugin@0.1.0-rc.2' });
  });

  it('trims surrounding whitespace from a paste', () => {
    expect(parseNpmSpec('  walnut-plugin@1.0.0\n')?.spec).toBe('walnut-plugin@1.0.0');
  });

  it('rejects argument injection and control characters', () => {
    expect(isValidNpmSpec('--registry=http://evil.test')).toBe(false);
    expect(isValidNpmSpec('-g')).toBe(false);
    expect(isValidNpmSpec('pkg --ignore-scripts=false')).toBe(false);
    expect(isValidNpmSpec('pkg\tname')).toBe(false);
    expect(isValidNpmSpec('pkg name')).toBe(false);
    expect(isValidNpmSpec('pkg\u0000name')).toBe(false);
    expect(isValidNpmSpec('pkg\u007fname')).toBe(false);
    expect(isValidNpmSpec('pkg;rm -rf /')).toBe(false);
    expect(isValidNpmSpec('pkg$(whoami)')).toBe(false);
  });

  it('rejects every non-registry fetcher', () => {
    for (const spec of [
      'https://evil.test/pkg.tgz',
      'http://evil.test/pkg.tgz',
      'git+https://host/repo.git',
      'git+ssh://git@host/repo.git',
      'git://host/repo.git',
      'file:../local-pkg',
      'npm:other-package@1.0.0',
      'github:owner/repo',
      'gitlab:owner/repo',
      'bitbucket:owner/repo',
      'gist:abc123',
      'link:../pkg',
      'workspace:*',
    ]) {
      expect(isValidNpmSpec(spec), spec).toBe(false);
    }
  });

  it('rejects filesystem paths', () => {
    for (const spec of ['./pkg', '../pkg', '/abs/pkg', '~/pkg', 'a/b', 'a/b/c', '..', '.', 'x\\y']) {
      expect(isValidNpmSpec(spec), spec).toBe(false);
    }
  });

  it('rejects version ranges — a range would change code without consent', () => {
    for (const spec of [
      'pkg@^1.0.0', 'pkg@~1.0.0', 'pkg@>=1.0.0', 'pkg@<2', 'pkg@*', 'pkg@1.x', 'pkg@1.2',
      'pkg@1', 'pkg@x', 'pkg@1.0.0||2.0.0', 'pkg@=1.0.0',
    ]) {
      expect(isValidNpmSpec(spec), spec).toBe(false);
    }
  });

  it('rejects malformed names and empty versions', () => {
    for (const spec of ['', '   ', 'pkg@', '@', '@scope', '@scope/', 'UPPER', '.hidden', '_private', '@/name']) {
      expect(isValidNpmSpec(spec), spec).toBe(false);
    }
  });
});

describe('slugForNpmPackage', () => {
  it('prefixes npm slugs to distinguish ordinary same-name Git repositories', () => {
    expect(slugForNpmPackage('walnut-plugin')).toBe('npm-walnut-plugin');
    expect(slugForNpmPackage('@acme/walnut-plugin')).toBe('npm-acme-walnut-plugin');
  });

  it('never produces a traversal segment', () => {
    // A hand-edited config could hold anything; the slug is joined onto a path.
    expect(slugForNpmPackage('..')).toBe('npm-.');
    expect(slugForNpmPackage('../../etc')).toBe('npm-.-.-etc');
    for (const name of ['..', '../..', 'a/../../b', '....']) {
      expect(slugForNpmPackage(name).includes('..'), name).toBe(false);
    }
  });
});

describe('sanitizeNpmOutput', () => {
  it('masks credential-shaped text from npm chatter', () => {
    expect(sanitizeNpmOutput('//registry.test/:_authToken=abc123xyz')).toContain('_authToken=***');
    expect(sanitizeNpmOutput('//registry.test/:_authToken=abc123xyz')).not.toContain('abc123xyz');
    expect(sanitizeNpmOutput('authorization: Bearer sekret-token')).not.toContain('sekret-token');
    expect(sanitizeNpmOutput('fetch https://me:pw@registry.test/pkg')).toBe('fetch https://***@registry.test/pkg');
  });
});

// ── Resolve ──

describe('resolveNpmSpec', () => {
  it('pins a tag to the exact version the registry reports', async () => {
    registryFixtures['walnut-plugin'] = { version: '2.3.4', integrity: 'sha512-AAAA==' };
    const resolved = await resolveNpmSpec('walnut-plugin@latest', { cwd: tmpRoot });
    expect(resolved).toMatchObject({ name: 'walnut-plugin', version: '2.3.4', resolved: 'walnut-plugin@2.3.4', integrity: 'sha512-AAAA==' });
    expect(npmCalls[0]).toEqual([
      'info', '--json', '--', 'walnut-plugin@latest', 'name', 'version', 'dist.integrity', 'dist.tarball',
    ]);
  });

  it('refuses a registry response that disagrees with an exact pin', async () => {
    registryFixtures['walnut-plugin'] = { version: '2.0.0', integrity: 'sha512-PIN==' };
    await expect(resolveNpmSpec('walnut-plugin@1.0.0', { cwd: tmpRoot }))
      .rejects.toThrow('returned version "2.0.0" for exact pin');
  });

  it('accepts sha1 and multiple valid SRI tokens', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      integrity: 'sha1-AAAA== sha512-BBBB==',
    };
    await expect(resolveNpmSpec('walnut-plugin', { cwd: tmpRoot }))
      .resolves.toMatchObject({ integrity: 'sha1-AAAA== sha512-BBBB==' });
  });

  it('refuses a response describing a different package', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0' };
    setNpmRunner(async () => ({ stdout: JSON.stringify({ name: 'other-package', version: '1.0.0' }), stderr: '' }));
    await expect(resolveNpmSpec('walnut-plugin', { cwd: tmpRoot }))
      .rejects.toThrow('refusing to install a different package');
  });

  it('refuses a malformed integrity value', async () => {
    setNpmRunner(async () => ({
      stdout: JSON.stringify({ name: 'walnut-plugin', version: '1.0.0', 'dist.integrity': 'not-an-integrity' }),
      stderr: '',
    }));
    await expect(resolveNpmSpec('walnut-plugin', { cwd: tmpRoot })).rejects.toThrow('malformed integrity');
  });

  it('rejects an invalid spec before spawning bun', async () => {
    await expect(resolveNpmSpec('--registry=http://evil.test', { cwd: tmpRoot }))
      .rejects.toThrow('Invalid npm package spec');
    expect(npmCalls).toHaveLength(0);
  });
});

// ── Install ──

describe('installNpmPlugin', () => {
  const finalDir = () => path.join(stagingRoot(), 'npm-walnut-plugin');

  it('installs with lifecycle scripts disabled and the exact resolved version', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.4.0',
      integrity: 'sha512-BBBB==',
      files: { 'manifest.json': MANIFEST('walnut-plugin'), 'index.js': '// plugin' },
    };
    const result = await installNpmPlugin({
      spec: 'walnut-plugin@latest',
      finalDir: finalDir(),
      stagingRoot: stagingRoot(),
    });

    expect(result).toMatchObject({
      name: 'walnut-plugin', version: '1.4.0', resolved: 'walnut-plugin@1.4.0', integrity: 'sha512-BBBB==',
    });
    const install = npmCalls.find(c => c[0] === 'add')!;
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--omit=dev');
    expect(install).toContain('--exact');
    expect(install).toContain('--linker=hoisted');
    expect(install).toContain('--backend=copyfile');
    expect(install).toContain('--save-text-lockfile');
    // The tag is resolved once; bun only ever sees the pinned version, after `--`.
    expect(install[install.length - 1]).toBe('walnut-plugin@1.4.0');
    expect(install[install.length - 2]).toBe('--');
    expect(install).not.toContain('walnut-plugin@latest');

    // Package landed at the final path, its dependency moved under it from beside it.
    expect(fs.existsSync(path.join(finalDir(), 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(finalDir(), 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(finalDir(), 'node_modules', '.bin'))).toBe(false);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('persists integrity from the bun.lock receipt', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      receiptIntegrity: 'sha512-RECEIPT==',
      files: { 'manifest.json': MANIFEST('p') },
    };
    const result = await installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    });
    expect(result.integrity).toBe('sha512-RECEIPT==');
  });

  it('rejects a receipt whose integrity differs from the registry resolution', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      integrity: 'sha512-VIEW==',
      receiptIntegrity: 'sha512-INSTALLED==',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('integrity does not match');
    expect(fs.existsSync(finalDir())).toBe(false);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('fails closed when bun omits or corrupts the bun.lock receipt', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', omitReceipt: true, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('did not produce a readable bun.lock receipt');

    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', omitReceiptRoot: true, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('has no entry for the Plugin package walnut-plugin');
    expect(fs.existsSync(finalDir())).toBe(false);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('moves every hoisted dependency under the plugin, scoped ones and their own nested copies too', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      files: { 'manifest.json': MANIFEST('p') },
      hoisted: {
        'left-pad': { 'index.js': '// left-pad' },
        '@acme/util': { 'index.js': '// util' },
        // Another version of ms, nested by bun under the dependency that needs it.
        debug: { 'index.js': '// debug', 'node_modules/ms/index.js': '// ms 2.0.0' },
        ms: { 'index.js': '// ms 2.1.3' },
      },
    };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });
    const own = path.join(finalDir(), 'node_modules');
    expect(fs.readFileSync(path.join(own, '@acme', 'util', 'index.js'), 'utf8')).toBe('// util');
    expect(fs.readFileSync(path.join(own, 'ms', 'index.js'), 'utf8')).toBe('// ms 2.1.3');
    expect(fs.readFileSync(path.join(own, 'debug', 'node_modules', 'ms', 'index.js'), 'utf8')).toBe('// ms 2.0.0');
    expect(fs.readdirSync(own).sort()).toEqual(['@acme', 'debug', 'left-pad', 'ms']);
  });

  it('refuses a tree that needs two versions of one package beside the plugin', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      files: { 'manifest.json': MANIFEST('p') },
      hoisted: { ms: { 'index.js': '// ms 2.0.0, for a dependency' } },
      nested: { ms: { 'index.js': '// ms 2.1.3, the plugin\'s own' } },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('walnut-plugin needs two versions of ms beside it');
    expect(fs.existsSync(finalDir())).toBe(false);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('refuses a hoisted dependency that is a symlink', async () => {
    const outside = path.join(tmpRoot, 'outside-dep');
    await fsp.mkdir(outside, { recursive: true });
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p') }, hoisted: {} };
    setNpmRunner(async (args, opts) => {
      const out = await fakeRunner(args, opts);
      if (args[0] === 'add') await fsp.symlink(outside, path.join(opts.cwd, 'node_modules', 'linked-dep'), 'dir');
      return out;
    });
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('installed dependency "linked-dep" is a symlink');
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('rejects a receipt from a different or insecure tarball origin', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      receiptResolved: 'https://other.example/walnut-plugin.tgz',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('different tarball origin');

    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      receiptResolved: 'http://registry.example/walnut-plugin.tgz',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('must be an HTTPS URL');
  });

  it('accepts a receipt naming the registry tarball by its full URL', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      receiptResolved: 'https://registry.example/walnut-plugin/-/walnut-plugin-1.0.0.tgz',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).resolves.toMatchObject({ tarball: 'https://registry.example/walnut-plugin/-/walnut-plugin-1.0.0.tgz' });
  });

  it('reads "" in the receipt as a tarball on registry.npmjs.org, and checks its origin like any other', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', registryOrigin: 'https://registry.npmjs.org', receiptResolved: '', files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).resolves.toMatchObject({ tarball: 'https://registry.npmjs.org/walnut-plugin/-/walnut-plugin-1.0.0.tgz' });

    // A mirror advertised its own tarball, and bun says it fetched from npmjs: not the advertised origin.
    registryFixtures['walnut-plugin'] = { version: '1.0.0', receiptResolved: '', files: { 'manifest.json': MANIFEST('p') } };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: path.join(stagingRoot(), 'npm-walnut-plugin-2'), stagingRoot: stagingRoot(),
    })).rejects.toThrow('different tarball origin');
  });

  it('refuses a plugin whose own node_modules is a symlink, moving nothing through it', async () => {
    const outside = path.join(tmpRoot, 'outside-modules');
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', ownModulesSymlinkTo: outside, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow("the Plugin package's node_modules is a symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each([
    ['another version', { receiptIdent: 'walnut-plugin@9.9.9' }, 'expected walnut-plugin@1.0.0'],
    ['a source that is not a registry tarball', { receiptNotRegistry: true }, 'something other than a registry tarball'],
  ])('rejects a receipt for %s', async (_label, flags, message) => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', ...flags, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow(message);
  });

  it('supports scoped packages', async () => {
    registryFixtures['@acme/walnut-plugin'] = {
      version: '1.0.0', files: { 'manifest.json': MANIFEST('scoped') },
    };
    await expect(installNpmPlugin({
      spec: '@acme/walnut-plugin',
      finalDir: path.join(stagingRoot(), 'npm-acme-walnut-plugin'),
      stagingRoot: stagingRoot(),
    })).resolves.toMatchObject({ name: '@acme/walnut-plugin' });
  });

  it('ignores an attacker-controlled lockfile inside the package root', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      integrity: 'sha512-REAL==',
      files: {
        'manifest.json': MANIFEST('p'),
        'package-lock.json': JSON.stringify({ integrity: 'sha512-FAKE==' }),
        'bun.lock': JSON.stringify({ lockfileVersion: 2, packages: { 'walnut-plugin': ['walnut-plugin@1.0.0', '', {}, 'sha512-FAKE=='] } }),
      },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).resolves.toMatchObject({ integrity: 'sha512-REAL==' });
  });

  it('stages in a 0700 directory', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p') } };
    let stagingMode = -1;
    const spy: NpmRunner = async (args, opts) => {
      if (args[0] === 'add') stagingMode = fs.statSync(opts.cwd).mode & 0o777;
      return fakeRunner(args, opts);
    };
    setNpmRunner(spy);
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });
    expect(stagingMode).toBe(0o700);
  });

  it('cleans up and installs nothing when the package has no root manifest.json', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'index.js': '// no manifest' } };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('not a Walnut plugin');

    expect(fs.existsSync(finalDir())).toBe(false);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('rejects an invalid root manifest.json', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': '{not json' } };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('invalid manifest.json');
    expect(fs.existsSync(finalDir())).toBe(false);
  });

  it('rejects a manifest with no string id', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': '{"name":"x"}' } };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('without a string "id"');
  });

  it('rejects a package.json that drifts from the registry metadata', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      packageJsonName: 'something-else',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('expected walnut-plugin@1.0.0');
    expect(fs.existsSync(finalDir())).toBe(false);
  });

  it('refuses a symlinked package root (path-escape regression)', async () => {
    const outside = path.join(tmpRoot, 'outside-target');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'manifest.json'), MANIFEST('evil'));
    registryFixtures['walnut-plugin'] = { version: '1.0.0', symlinkTo: outside };

    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('is a symlink');

    expect(fs.existsSync(finalDir())).toBe(false);
    // The symlink target must be untouched — cleanup removes only staging.
    expect(fs.existsSync(path.join(outside, 'manifest.json'))).toBe(true);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('refuses a symlinked node_modules (path-escape regression)', async () => {
    const outside = path.join(tmpRoot, 'outside-modules');
    registryFixtures['walnut-plugin'] = { version: '1.0.0', modulesSymlinkTo: outside };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('is a symlink');
  });

  it('refuses a scoped package whose scope directory is a symlink', async () => {
    registryFixtures['@acme/walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p') } };
    const scopeTarget = path.join(tmpRoot, 'outside-scope');
    const spy: NpmRunner = async (args, opts) => {
      if (args[0] !== 'add') return fakeRunner(args, opts);
      const prefix = opts.cwd;
      await fsp.mkdir(path.join(scopeTarget, 'walnut-plugin'), { recursive: true });
      await fsp.writeFile(path.join(scopeTarget, 'walnut-plugin', 'manifest.json'), MANIFEST('p'));
      await fsp.mkdir(path.join(prefix, 'node_modules'), { recursive: true });
      await fsp.symlink(scopeTarget, path.join(prefix, 'node_modules', '@acme'), 'dir');
      return { stdout: '', stderr: '' };
    };
    setNpmRunner(spy);
    await expect(installNpmPlugin({
      spec: '@acme/walnut-plugin',
      finalDir: path.join(stagingRoot(), 'npm-acme-walnut-plugin'),
      stagingRoot: stagingRoot(),
    })).rejects.toThrow('is a symlink');
  });

  it('refuses a package path that is a plain file', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', asFile: true };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('is not a directory');
  });

  it('refuses to overwrite an existing final directory', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p') } };
    await fsp.mkdir(finalDir(), { recursive: true });
    await fsp.writeFile(path.join(finalDir(), 'keep-me.txt'), 'existing');
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('already exists');
    expect(fs.existsSync(path.join(finalDir(), 'keep-me.txt'))).toBe(true);
    expect(npmCalls).toHaveLength(0);
  });
});

// ── Replace (update) ──

describe('replaceNpmPlugin', () => {
  const finalDir = () => path.join(stagingRoot(), 'npm-walnut-plugin');

  it('swaps in the new version and removes the backup', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'old' } };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    registryFixtures['walnut-plugin'] = { version: '2.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'new' } };
    const result = await replaceNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    expect(result.resolved).toBe('walnut-plugin@2.0.0');
    expect(await fsp.readFile(path.join(finalDir(), 'v.txt'), 'utf-8')).toBe('new');
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('leaves the old version in place when the new one fails verification', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'old' } };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    // New version ships no manifest → staging verification fails before any swap.
    registryFixtures['walnut-plugin'] = { version: '2.0.0', files: { 'index.js': '// oops' } };
    await expect(replaceNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() }))
      .rejects.toThrow('not a Walnut plugin');

    expect(await fsp.readFile(path.join(finalDir(), 'v.txt'), 'utf-8')).toBe('old');
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('rolls back when the state commit fails after the swap', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'old' } };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    registryFixtures['walnut-plugin'] = { version: '2.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'new' } };
    await expect(replaceNpmPlugin({
      spec: 'walnut-plugin',
      finalDir: finalDir(),
      stagingRoot: stagingRoot(),
      commit: async () => { throw new Error('state write failed'); },
    })).rejects.toThrow('state write failed');

    expect(await fsp.readFile(path.join(finalDir(), 'v.txt'), 'utf-8')).toBe('old');
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('rolls back to the backup when the final rename fails', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'old' } };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    registryFixtures['walnut-plugin'] = { version: '2.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'new' } };
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // finalDir → backup succeeds; the staged package → finalDir fails.
      if (String(to) === finalDir() && !String(from).includes('.backup-')) throw new Error('simulated rename failure');
      return realRename(from, to);
    });

    await expect(replaceNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() }))
      .rejects.toThrow('simulated rename failure');

    vi.restoreAllMocks();
    expect(await fsp.readFile(path.join(finalDir(), 'v.txt'), 'utf-8')).toBe('old');
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('preserves and reports the backup when rollback itself fails', async () => {
    registryFixtures['walnut-plugin'] = { version: '1.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'old' } };
    await installNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });

    registryFixtures['walnut-plugin'] = { version: '2.0.0', files: { 'manifest.json': MANIFEST('p'), 'v.txt': 'new' } };
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === finalDir() && !String(from).includes('.backup-')) throw new Error('swap failed');
      if (String(to) === finalDir()) throw new Error('restore failed');
      return realRename(from, to);
    });

    let message = '';
    try {
      await replaceNpmPlugin({ spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot() });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('update failed and rollback also failed');
    expect(message).toContain('Previous version is preserved at');
    expect(message).toContain('restore failed');

    vi.restoreAllMocks();
    expect(fs.existsSync(finalDir())).toBe(false);
    const backups = await leftoverTempDirs();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^\.backup-/);
    expect(await fsp.readFile(path.join(stagingRoot(), backups[0], 'v.txt'), 'utf8')).toBe('old');
  });
});

describe('parseBunLock', () => {
  it('reads bun.lock, trailing commas and all, and keeps commas inside strings', () => {
    const text = '{\n  "lockfileVersion": 2,\n  "packages": {\n    "a": ["a@1.0.0", "", { "x": "y,}" }, "sha512-A=="],\n  },\n}\n';
    expect(parseBunLock(text)).toEqual({ lockfileVersion: 2, packages: { a: ['a@1.0.0', '', { x: 'y,}' }, 'sha512-A=='] } });
    expect(parseBunLock('{"s": "a \\" ,]"}')).toEqual({ s: 'a " ,]' });
    expect(() => parseBunLock('{ nope')).toThrow();
  });
});
