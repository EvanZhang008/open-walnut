/**
 * Unit tests for the npm plugin installer — src/core/plugin-npm-install.ts.
 *
 * Zero network: every `npm` invocation goes through the injected runner seam, so
 * the tests assert the exact argv Walnut would hand to npm (notably
 * `--ignore-scripts`) and then materialize a fake install tree on disk to
 * exercise the verification + atomic-placement path for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseNpmSpec, isValidNpmSpec, slugForNpmPackage, sanitizeNpmOutput,
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
  receiptResolved?: string;
  omitReceipt?: boolean;
  omitReceiptRoot?: boolean;
  receiptRootKey?: string;
  receiptLink?: boolean;
  receiptInBundle?: boolean;
  hoistedDependency?: boolean;
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

const fakeRunner: NpmRunner = async (args) => {
  npmCalls.push([...args]);

  if (args[0] === 'view') {
    const spec = args[args.indexOf('--') + 1];
    const name = nameOf(spec);
    const pkg = registryFixtures[name];
    if (!pkg) throw new Error(`404 Not Found - GET https://registry.example/${name}`);
    return {
      stdout: JSON.stringify({
        name,
        version: pkg.version,
        ...(pkg.integrity ? { 'dist.integrity': pkg.integrity } : {}),
        'dist.tarball': `https://registry.example/${name}/-/${name}-${pkg.version}.tgz`,
      }),
      stderr: '',
    };
  }

  if (args[0] === 'install') {
    const prefix = args[args.indexOf('--prefix') + 1];
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
      return { stdout: 'added 1 package', stderr: '' };
    }
    if (pkg.asFile) {
      await fsp.writeFile(target, 'not a directory');
      return { stdout: 'added 1 package', stderr: '' };
    }

    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(
      path.join(target, 'package.json'),
      JSON.stringify({ name: pkg.packageJsonName ?? name, version: pkg.packageJsonVersion ?? pkg.version }),
    );
    for (const [rel, content] of Object.entries(pkg.files ?? {})) {
      const abs = path.join(target, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content);
    }
    // Nested install strategy: a dependency lives inside the package.
    const nestedDependency = path.join(target, 'node_modules', 'left-pad');
    await fsp.mkdir(nestedDependency, { recursive: true });
    await fsp.writeFile(path.join(nestedDependency, 'index.js'), '// dep');
    const packages: Record<string, Record<string, unknown>> = {};
    const rootKey = pkg.receiptRootKey ?? path.relative(prefix, target).replaceAll(path.sep, '/');
    if (!pkg.omitReceiptRoot) {
      packages[rootKey] = {
        version: pkg.version,
        resolved: pkg.receiptResolved ?? `https://registry.example/${name}/-/${name}-${pkg.version}.tgz`,
        integrity: pkg.receiptIntegrity ?? pkg.integrity ?? 'sha512-FAKE==',
        ...(pkg.receiptLink ? { link: true } : {}),
        ...(pkg.receiptInBundle ? { inBundle: true } : {}),
      };
    }
    packages[path.relative(prefix, nestedDependency).replaceAll(path.sep, '/')] = {
      version: '1.0.0',
      resolved: 'https://registry.example/left-pad/-/left-pad-1.0.0.tgz',
      integrity: 'sha512-LEFTPAD==',
    };
    if (pkg.hoistedDependency) {
      const hoisted = path.join(modulesDir, 'hoisted-dep');
      await fsp.mkdir(hoisted, { recursive: true });
      packages[path.relative(prefix, hoisted).replaceAll(path.sep, '/')] = {
        version: '1.0.0',
        resolved: 'https://registry.example/hoisted-dep/-/hoisted-dep-1.0.0.tgz',
        integrity: 'sha512-HOISTED==',
      };
    }
    if (!pkg.omitReceipt) {
      await fsp.writeFile(path.join(modulesDir, '.package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages,
      }));
    }
    return { stdout: 'added 2 packages', stderr: '' };
  }

  throw new Error(`unexpected npm command: ${args[0]}`);
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
      'view', '--json', '--', 'walnut-plugin@latest', 'name', 'version', 'dist.integrity', 'dist.tarball',
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

  it('rejects an invalid spec before spawning npm', async () => {
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
    const install = npmCalls.find(c => c[0] === 'install')!;
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--omit=dev');
    expect(install).toContain('--no-audit');
    expect(install).toContain('--no-fund');
    expect(install).toContain('--package-lock=false');
    expect(install).toContain('--install-strategy=nested');
    // The tag is resolved once; npm only ever sees the pinned version, after `--`.
    expect(install[install.length - 1]).toBe('walnut-plugin@1.4.0');
    expect(install[install.length - 2]).toBe('--');
    expect(install).not.toContain('walnut-plugin@latest');

    // Package landed at the final path with its nested dependency.
    expect(fs.existsSync(path.join(finalDir(), 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(finalDir(), 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(await leftoverTempDirs()).toEqual([]);
  });

  it('persists integrity from npm installed-tree receipt', async () => {
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

  it('fails closed when npm omits or corrupts the hidden lock receipt', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', omitReceipt: true, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('did not produce a readable hidden lockfile receipt');

    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', omitReceiptRoot: true, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('0 entries for the Plugin package root');
  });

  it('rejects hoisted dependencies that would be lost after placement', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', hoistedDependency: true, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow(/dependencies outside the Plugin package.*hoisted-dep/);
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

  it.each([
    ['link', { receiptLink: true }],
    ['bundled dependency', { receiptInBundle: true }],
  ])('rejects a root receipt described as %s', async (_label, flags) => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0', ...flags, files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).rejects.toThrow('link or bundled dependency');
  });

  it('matches receipt keys by resolved path and supports scoped packages', async () => {
    registryFixtures['walnut-plugin'] = {
      version: '1.0.0',
      receiptRootKey: 'node_modules/../node_modules/walnut-plugin',
      files: { 'manifest.json': MANIFEST('p') },
    };
    await expect(installNpmPlugin({
      spec: 'walnut-plugin', finalDir: finalDir(), stagingRoot: stagingRoot(),
    })).resolves.toMatchObject({ name: 'walnut-plugin' });

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
      if (args[0] === 'install') stagingMode = fs.statSync(opts.cwd).mode & 0o777;
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
      if (args[0] !== 'install') return fakeRunner(args, opts);
      const prefix = args[args.indexOf('--prefix') + 1];
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
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      // 1st = finalDir → backup (must succeed), 2nd = staged → finalDir (fail).
      if (calls === 2) throw new Error('simulated rename failure');
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
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('swap failed');
      if (calls === 3) throw new Error('restore failed');
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
