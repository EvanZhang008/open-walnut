/**
 * Unit tests for src/core/version.ts.
 *
 * The host version is what every plugin's `engines.walnut` range is checked
 * against, so "we could not find our own version" must be distinguishable from a
 * real version: '0.0.0' satisfies almost no range, and reporting it as a fact makes
 * a Walnut packaging bug look like a broken plugin.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getVersion, isVersionKnown } from '../../src/core/version.js';

const repoRoot = path.join(import.meta.dirname, '..', '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string };

/** A fresh module instance, so the process-lifetime cache does not leak between cases. */
async function freshVersionModule(): Promise<typeof import('../../src/core/version.js')> {
  vi.resetModules();
  return import('../../src/core/version.js');
}

describe('getVersion', () => {
  it('reports the root package.json version when running from source', () => {
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(getVersion()).toBe(rootPkg.version);
  });

  it('returns a stable value', () => {
    expect(getVersion()).toBe(getVersion());
  });
});

describe('isVersionKnown', () => {
  it('is true when a real version was found', () => {
    expect(isVersionKnown()).toBe(true);
    expect(getVersion()).not.toBe('0.0.0');
  });
});

describe('version sources', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__WALNUT_VERSION__;
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('prefers the baked build constant over the package.json walk', async () => {
    (globalThis as Record<string, unknown>).__WALNUT_VERSION__ = '9.9.9-probe';

    const version = await freshVersionModule();

    expect(version.getVersion()).toBe('9.9.9-probe');
    expect(version.isVersionKnown()).toBe(true);
  });

  it('falls through to the package.json walk when the baked constant is empty', async () => {
    (globalThis as Record<string, unknown>).__WALNUT_VERSION__ = '';

    const version = await freshVersionModule();

    expect(version.getVersion()).toBe(rootPkg.version);
    expect(version.isVersionKnown()).toBe(true);
  });

  it('reports 0.0.0 as UNKNOWN when no package.json can be found', async () => {
    vi.doMock('node:fs', () => ({
      default: { existsSync: () => false, readFileSync: () => '{}' },
      existsSync: () => false,
      readFileSync: () => '{}',
    }));

    const version = await freshVersionModule();

    expect(version.getVersion()).toBe('0.0.0');
    expect(version.isVersionKnown()).toBe(false);
  });
});

describe('build bakes the version in (ratchet)', () => {
  it('tsup define sources __WALNUT_VERSION__ from package.json', () => {
    const config = fs.readFileSync(path.join(repoRoot, 'tsup.config.ts'), 'utf-8');

    const defineBlock = config.match(/define:\s*\{[^}]*\}/)?.[0];
    expect(defineBlock, 'tsup.config.ts must declare a define block').toBeTruthy();
    // The value must be derived, never a literal: a hardcoded version silently
    // rots one release later and every plugin range starts failing.
    const binding = defineBlock!.match(/__WALNUT_VERSION__:\s*JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1];
    expect(binding, `define must be JSON.stringify(<variable>), got: ${defineBlock}`).toBeTruthy();
    expect(config).toMatch(new RegExp(`const\\s+${binding}\\b[^\\n]*readFileSync\\([^\\n]*package\\.json`));
  });
});
