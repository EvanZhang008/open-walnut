/**
 * Tests for repository-matcher.ts — CWD-to-repo matching logic.
 *
 * Creates temp repo YAML files with host path entries and verifies that
 * findRepoByPath() correctly matches CWD prefixes, picks longest match,
 * and respects host filters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('repo-matcher-test'));

import { findRepoByPath } from '../../src/core/repository-matcher.js';
import { REPOSITORIES_DIR } from '../../src/constants.js';

/** Write a YAML repo file directly to the repositories dir. */
async function writeRepo(slug: string, yaml: string): Promise<void> {
  await fsp.mkdir(REPOSITORIES_DIR, { recursive: true });
  await fsp.writeFile(path.join(REPOSITORIES_DIR, `${slug}.yaml`), yaml, 'utf-8');
}

beforeEach(async () => {
  await fsp.rm(REPOSITORIES_DIR, { recursive: true, force: true });
  await fsp.mkdir(REPOSITORIES_DIR, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(REPOSITORIES_DIR, { recursive: true, force: true });
});

describe('findRepoByPath', () => {
  it('returns undefined when no repos exist', () => {
    const result = findRepoByPath('/some/random/path');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty CWD', () => {
    const result = findRepoByPath('');
    expect(result).toBeUndefined();
  });

  it('matches CWD that is exactly the host path', async () => {
    await writeRepo('walnut', [
      'name: Open Walnut',
      'description: Personal AI',
      'hosts:',
      '  local:',
      '    path: /tmp/test-walnut-exact',
    ].join('\n'));

    // Create the directory so path.resolve works consistently
    await fsp.mkdir('/tmp/test-walnut-exact', { recursive: true });

    const result = findRepoByPath('/tmp/test-walnut-exact');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Open Walnut');
    expect(result!.slug).toBe('walnut');
    expect(result!.description).toBe('Personal AI');
  });

  it('matches CWD that is a subdirectory of host path', async () => {
    const basePath = `/tmp/repo-matcher-test-${process.pid}`;
    await fsp.mkdir(path.join(basePath, 'src', 'core'), { recursive: true });

    await writeRepo('myproject', [
      'name: My Project',
      'description: Test project',
      'hosts:',
      '  local:',
      `    path: ${basePath}`,
    ].join('\n'));

    const result = findRepoByPath(path.join(basePath, 'src', 'core'));
    expect(result).toBeDefined();
    expect(result!.name).toBe('My Project');
    expect(result!.slug).toBe('myproject');

    await fsp.rm(basePath, { recursive: true, force: true });
  });

  it('does NOT match CWD outside the host path', async () => {
    await writeRepo('narrow', [
      'name: Narrow',
      'hosts:',
      '  local:',
      '    path: /tmp/repo-narrow-abc123',
    ].join('\n'));

    const result = findRepoByPath('/tmp/other-directory');
    expect(result).toBeUndefined();
  });

  it('does NOT match CWD that shares a prefix but is a different dir', async () => {
    // /tmp/foo should NOT match /tmp/foobar
    await writeRepo('foo-repo', [
      'name: Foo',
      'hosts:',
      '  local:',
      '    path: /tmp/repo-matcher-foo',
    ].join('\n'));

    const result = findRepoByPath('/tmp/repo-matcher-foobar');
    expect(result).toBeUndefined();
  });

  it('picks the longest matching path when multiple repos overlap', async () => {
    const base = `/tmp/repo-matcher-overlap-${process.pid}`;
    const nested = path.join(base, 'packages', 'core');
    await fsp.mkdir(nested, { recursive: true });

    await writeRepo('parent', [
      'name: Parent Monorepo',
      'hosts:',
      '  local:',
      `    path: ${base}`,
    ].join('\n'));

    await writeRepo('child', [
      'name: Core Package',
      'hosts:',
      '  local:',
      `    path: ${nested}`,
    ].join('\n'));

    // Query a subdir of the more specific path — should match "child"
    const result = findRepoByPath(path.join(nested, 'src'));
    expect(result).toBeDefined();
    expect(result!.name).toBe('Core Package');
    expect(result!.slug).toBe('child');

    // Query the parent directly — should match "parent"
    const parentResult = findRepoByPath(path.join(base, 'docs'));
    expect(parentResult).toBeDefined();
    expect(parentResult!.name).toBe('Parent Monorepo');

    await fsp.rm(base, { recursive: true, force: true });
  });

  it('filters by host label when specified', async () => {
    const localPath = `/tmp/repo-matcher-host-filter-local-${process.pid}`;
    const cloudPath = `/tmp/repo-matcher-host-filter-cloud-${process.pid}`;
    await fsp.mkdir(localPath, { recursive: true });

    await writeRepo('multi-host', [
      'name: Multi Host Repo',
      'hosts:',
      '  local:',
      `    path: ${localPath}`,
      '  cloud-desktop:',
      `    path: ${cloudPath}`,
    ].join('\n'));

    // Should match when filtering by 'local'
    const localResult = findRepoByPath(localPath, 'local');
    expect(localResult).toBeDefined();
    expect(localResult!.name).toBe('Multi Host Repo');

    // Should NOT match when filtering by 'cloud-desktop' for a local path
    const cloudResult = findRepoByPath(localPath, 'cloud-desktop');
    expect(cloudResult).toBeUndefined();

    await fsp.rm(localPath, { recursive: true, force: true });
  });

  it('returns undefined when REPOSITORIES_DIR does not exist', async () => {
    await fsp.rm(REPOSITORIES_DIR, { recursive: true, force: true });
    const result = findRepoByPath('/tmp/anything');
    expect(result).toBeUndefined();
  });

  it('extracts tech_stack from repo YAML', async () => {
    const repoPath = `/tmp/repo-matcher-techstack-${process.pid}`;
    await fsp.mkdir(repoPath, { recursive: true });

    await writeRepo('techrepo', [
      'name: Tech Repo',
      'tech_stack: [TypeScript, React, Node.js]',
      'hosts:',
      '  local:',
      `    path: ${repoPath}`,
    ].join('\n'));

    const result = findRepoByPath(repoPath);
    expect(result).toBeDefined();
    expect(result!.tech_stack).toBe('TypeScript, React, Node.js');

    await fsp.rm(repoPath, { recursive: true, force: true });
  });

  it('extracts multiline architecture_notes', async () => {
    const repoPath = `/tmp/repo-matcher-arch-${process.pid}`;
    await fsp.mkdir(repoPath, { recursive: true });

    await writeRepo('archrepo', [
      'name: Arch Repo',
      'architecture_notes: |',
      '  Frontend is React SPA.',
      '  Backend is Express + SQLite.',
      'hosts:',
      '  local:',
      `    path: ${repoPath}`,
    ].join('\n'));

    const result = findRepoByPath(repoPath);
    expect(result).toBeDefined();
    expect(result!.architecture_notes).toContain('React SPA');
    expect(result!.architecture_notes).toContain('Express');

    await fsp.rm(repoPath, { recursive: true, force: true });
  });

  it('uses slug as name fallback when name: is absent', async () => {
    const repoPath = `/tmp/repo-matcher-noname-${process.pid}`;
    await fsp.mkdir(repoPath, { recursive: true });

    await writeRepo('unnamed-project', [
      'description: A project without explicit name',
      'hosts:',
      '  local:',
      `    path: ${repoPath}`,
    ].join('\n'));

    const result = findRepoByPath(repoPath);
    expect(result).toBeDefined();
    expect(result!.name).toBe('unnamed-project');
    expect(result!.slug).toBe('unnamed-project');

    await fsp.rm(repoPath, { recursive: true, force: true });
  });

  it('skips YAML files without any hosts section', async () => {
    const repoPath = `/tmp/repo-matcher-nohosts-${process.pid}`;
    await fsp.mkdir(repoPath, { recursive: true });

    await writeRepo('hostless', [
      'name: Hostless Repo',
      'description: No hosts defined',
    ].join('\n'));

    // No match possible since there are no host paths
    const result = findRepoByPath(repoPath);
    expect(result).toBeUndefined();

    await fsp.rm(repoPath, { recursive: true, force: true });
  });

  it('reads both .yaml and .yml extensions', async () => {
    const repoPath = `/tmp/repo-matcher-yml-${process.pid}`;
    await fsp.mkdir(repoPath, { recursive: true });

    // Write a .yml file (not .yaml)
    await fsp.writeFile(
      path.join(REPOSITORIES_DIR, 'ymlrepo.yml'),
      [
        'name: YML Repo',
        'hosts:',
        '  local:',
        `    path: ${repoPath}`,
      ].join('\n'),
      'utf-8',
    );

    const result = findRepoByPath(repoPath);
    expect(result).toBeDefined();
    expect(result!.name).toBe('YML Repo');
    expect(result!.slug).toBe('ymlrepo');

    await fsp.rm(repoPath, { recursive: true, force: true });
  });
});
