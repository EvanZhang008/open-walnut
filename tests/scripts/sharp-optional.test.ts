import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLE_EXTERNAL, CLI_FAST_FROM_DISK } from '../../scripts/build-cli-fast.mjs';

// sharp (image resizing) is optional: Walnut starts, and images pass through
// unresized, on a machine where it does not install or load.

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
};

describe('sharp is optional', () => {
  it('is an optional dependency, not a required one', () => {
    expect(pkg.dependencies.sharp).toBeUndefined();
    expect(pkg.optionalDependencies.sharp).toBeDefined();
  });

  it('stays external in the server bundle and in cli-fast (optionalDependencies are not auto-external)', () => {
    const tsup = readFileSync(path.join(root, 'tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/^\s*external: BUNDLE_EXTERNAL,$/m);
    expect(BUNDLE_EXTERNAL).toContain('sharp');
    // dist/cli-fast.js is bun's build (scripts/build-cli-fast.mjs): it takes the same list.
    const cliFast = readFileSync(path.join(root, 'scripts/build-cli-fast.mjs'), 'utf8');
    expect(cliFast).toContain('external: [...BUNDLE_EXTERNAL, ...CLI_FAST_FROM_DISK],');
    expect(CLI_FAST_FROM_DISK).not.toContain('sharp');
  });
});

describe('image compression degrades without sharp', () => {
  it('loads sharp lazily and survives its absence', () => {
    const src = readFileSync(path.join(root, 'src/utils/image-compress.ts'), 'utf8');
    expect(src).not.toMatch(/^import sharp from 'sharp'/m);
    expect(src).toContain("import('sharp')");
  });
});
