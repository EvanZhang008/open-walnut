import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A machine whose C library predates the prebuilt native binaries (glibc < 2.29) must
// not fail `npm install` minutes into a compile with no explanation, and must not fail
// it at all over sharp, which Walnut can live without. These pin the wiring.

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
};

describe('native toolchain: install-time wiring', () => {
  it('sharp is optional, not required', () => {
    expect(pkg.dependencies.sharp).toBeUndefined();
    expect(pkg.optionalDependencies.sharp).toBeDefined();
  });

  it('sharp stays external in the server bundle (optionalDependencies are not auto-external)', () => {
    const tsup = readFileSync(path.join(root, 'tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/external:\s*\[[^\]]*'sharp'/);
  });

  it('the toolchain check runs before any dependency is fetched', () => {
    expect(pkg.scripts.preinstall).toBe('node scripts/check-native-toolchain.mjs');
  });

  it('the check is silent and exits 0 where nothing will compile (this machine or an opt-out)', () => {
    const script = path.join(root, 'scripts/check-native-toolchain.mjs');
    const here = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, WALNUT_SKIP_TOOLCHAIN_CHECK: '1' } });
    expect(here.status).toBe(0);
    expect(here.stdout + here.stderr).toBe('');
  });

  it('the failure message names the fix, not just the problem', () => {
    const src = readFileSync(path.join(root, 'scripts/check-native-toolchain.mjs'), 'utf8');
    for (const must of ['gcc10-c++', 'CC=gcc10-gcc CXX=gcc10-g++ npm install', 'WALNUT_SKIP_TOOLCHAIN_CHECK=1', 'npm_config_build_from_source']) {
      expect(src).toContain(must);
    }
  });
});

describe('image compression degrades without sharp', () => {
  it('loads sharp lazily and survives its absence', () => {
    const src = readFileSync(path.join(root, 'src/utils/image-compress.ts'), 'utf8');
    expect(src).not.toMatch(/^import sharp from 'sharp'/m);
    expect(src).toContain("import('sharp')");
  });
});
