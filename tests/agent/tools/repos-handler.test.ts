/**
 * Tests for repos/ URI routing in the files_* tool group.
 *
 * Covers:
 * - resolveSource('repos/') → type='repos', variant='repos-list'
 * - resolveSource('repos/{name}') → type='repos', variant='named'
 * - Path traversal rejection (repos/../escape)
 * - Handler write + read + list + edit cycle via executeTool()
 * - listRepoSummaries() for agent context
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('repos-handler-test'));

import { WALNUT_HOME, REPOSITORIES_DIR } from '../../../src/constants.js';
import { resolveSource } from '../../../src/agent/tools/files/resolver.js';
import { reposHandler, listRepoSummaries } from '../../../src/agent/tools/files/repos-handler.js';
import { executeTool } from '../../../src/agent/tools.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── Resolver Tests ─────────────────────────────────────────────────

describe('resolveSource — repos/ routing', () => {
  it('resolves "repos/" to repos-list variant', () => {
    const r = resolveSource('repos/');
    expect(r.type).toBe('repos');
    expect(r.variant).toBe('repos-list');
    expect(r.filePath).toBe(REPOSITORIES_DIR);
  });

  it('resolves "repos" (no trailing slash) to repos-list variant', () => {
    const r = resolveSource('repos');
    expect(r.type).toBe('repos');
    expect(r.variant).toBe('repos-list');
  });

  it('resolves "repos/walnut" to named variant', () => {
    const r = resolveSource('repos/walnut');
    expect(r.type).toBe('repos');
    expect(r.variant).toBe('named');
    expect(r.meta?.name).toBe('walnut');
    expect(r.filePath).toBe(path.join(REPOSITORIES_DIR, 'walnut.yaml'));
  });

  it('resolves "repos/my-project" with hyphens', () => {
    const r = resolveSource('repos/my-project');
    expect(r.type).toBe('repos');
    expect(r.variant).toBe('named');
    expect(r.meta?.name).toBe('my-project');
  });

  it('throws on path traversal: repos/../escape', () => {
    expect(() => resolveSource('repos/../escape')).toThrow('Invalid repo name');
  });

  it('throws on nested slash: repos/foo/bar', () => {
    expect(() => resolveSource('repos/foo/bar')).toThrow('Invalid repo name');
  });

  it('throws on empty name: repos/ followed by nothing resolves as list', () => {
    // "repos/" is treated as the list variant, not an error
    const r = resolveSource('repos/');
    expect(r.variant).toBe('repos-list');
  });
});

// ─── Handler Direct Tests ───────────────────────────────────────────

describe('reposHandler — write + read + list + edit', () => {
  const sampleYaml = [
    'name: Test Repo',
    'description: A test repository',
    'tech_stack: [TypeScript, Vitest]',
    'hosts:',
    '  local:',
    '    path: /tmp/test-repo',
  ].join('\n');

  it('write creates a new repo file', async () => {
    const resolved = resolveSource('repos/test-repo');

    const writeResult = await reposHandler.write(resolved, sampleYaml, {});
    expect(writeResult.status).toBe('created');
    expect(writeResult.content_hash).toBeTruthy();

    // Verify file exists on disk
    const content = await fs.readFile(resolved.filePath, 'utf-8');
    expect(content).toBe(sampleYaml);
  });

  it('write then read cycle preserves content', async () => {
    const resolved = resolveSource('repos/cycle-test');

    await reposHandler.write(resolved, sampleYaml, {});
    const readResult = await reposHandler.read(resolved, {});

    // readResult could be FilesReadResult or ToolResultContent
    expect('content' in readResult).toBe(true);
    const result = readResult as { content: string; content_hash: string; total_lines: number };
    // readFileWithMeta adds line numbers (cat -n style), so check each line is present
    expect(result.content).toContain('name: Test Repo');
    expect(result.content).toContain('description: A test repository');
    expect(result.content).toContain('path: /tmp/test-repo');
    expect(result.content_hash).toBeTruthy();
    expect(result.total_lines).toBe(6);
  });

  it('write with content_hash updates existing file', async () => {
    const resolved = resolveSource('repos/update-test');

    // First write (no hash needed for new file)
    const createResult = await reposHandler.write(resolved, sampleYaml, {});
    expect(createResult.status).toBe('created');

    // Second write requires hash
    const updated = sampleYaml.replace('A test repository', 'Updated description');
    const updateResult = await reposHandler.write(resolved, updated, {
      contentHash: createResult.content_hash,
    });
    expect(updateResult.status).toBe('updated');

    // Verify content on disk
    const content = await fs.readFile(resolved.filePath, 'utf-8');
    expect(content).toContain('Updated description');
  });

  it('write rejects overwrite of existing file without content_hash', async () => {
    const resolved = resolveSource('repos/guard-test');
    await reposHandler.write(resolved, sampleYaml, {});

    await expect(
      reposHandler.write(resolved, 'overwrite attempt', {}),
    ).rejects.toThrow('content_hash is required');
  });

  it('list returns all repos with metadata', async () => {
    const resolved = resolveSource('repos/');

    // Write two repos
    await reposHandler.write(resolveSource('repos/alpha'), [
      'name: Alpha',
      'description: First repo',
      'hosts:',
      '  local:',
      '    path: /tmp/alpha',
    ].join('\n'), {});

    await reposHandler.write(resolveSource('repos/beta'), [
      'name: Beta',
      'description: Second repo',
      'hosts:',
      '  local:',
      '    path: /tmp/beta',
    ].join('\n'), {});

    const items = await reposHandler.list(resolved);
    expect(items).toHaveLength(2);

    const names = items.map(i => i.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']);

    // Each item should have source as repos/{slug}
    const sources = items.map(i => i.source).sort();
    expect(sources).toEqual(['repos/alpha', 'repos/beta']);

    // Each item should have description and size
    for (const item of items) {
      expect(item.description).toBeTruthy();
      expect(item.size).toBeGreaterThan(0);
      expect(item.modified).toBeTruthy();
    }
  });

  it('list returns empty when no repos exist', async () => {
    const resolved = resolveSource('repos/');
    const items = await reposHandler.list(resolved);
    expect(items).toEqual([]);
  });

  it('edit modifies content in-place', async () => {
    const resolved = resolveSource('repos/edit-target');
    const createResult = await reposHandler.write(resolved, sampleYaml, {});

    const editResult = await reposHandler.edit(
      resolved,
      'A test repository',
      'An edited repository',
      { contentHash: createResult.content_hash },
    );
    expect(editResult.status).toBe('updated');
    expect(editResult.replacements).toBe(1);
    expect(editResult.content_hash).toBeTruthy();

    // Verify on disk
    const content = await fs.readFile(resolved.filePath, 'utf-8');
    expect(content).toContain('An edited repository');
    expect(content).not.toContain('A test repository');
  });

  it('edit requires content_hash', async () => {
    const resolved = resolveSource('repos/edit-nohash');
    await reposHandler.write(resolved, sampleYaml, {});

    await expect(
      reposHandler.edit(resolved, 'A test', 'New', {}),
    ).rejects.toThrow('content_hash is required');
  });

  it('edit requires old_content', async () => {
    const resolved = resolveSource('repos/edit-noold');
    const writeResult = await reposHandler.write(resolved, sampleYaml, {});

    await expect(
      reposHandler.edit(resolved, '', 'New', { contentHash: writeResult.content_hash }),
    ).rejects.toThrow('old_content cannot be empty');
  });

  it('append mode works', async () => {
    const resolved = resolveSource('repos/append-test');
    await reposHandler.write(resolved, sampleYaml, {});

    const appendResult = await reposHandler.write(resolved, '\n# Extra section\n', { mode: 'append' });
    expect(appendResult.status).toBe('appended');

    const content = await fs.readFile(resolved.filePath, 'utf-8');
    expect(content).toContain(sampleYaml);
    expect(content).toContain('# Extra section');
  });
});

// ─── listRepoSummaries (used by buildMemoryContext) ─────────────────

describe('listRepoSummaries', () => {
  it('returns empty array when no repos exist', () => {
    const summaries = listRepoSummaries();
    expect(summaries).toEqual([]);
  });

  it('returns summaries with name, description, and hosts', async () => {
    await fs.mkdir(REPOSITORIES_DIR, { recursive: true });
    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'walnut.yaml'),
      [
        'name: Open Walnut',
        'description: Personal AI',
        'hosts:',
        '  local:',
        '    path: /home/user/walnut',
        '  cloud-desktop:',
        '    path: /workspace/walnut',
      ].join('\n'),
      'utf-8',
    );

    const summaries = listRepoSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('Open Walnut');
    expect(summaries[0].description).toBe('Personal AI');
    expect(summaries[0].hosts).toContain('local');
    expect(summaries[0].hosts).toContain('cloud-desktop');
  });

  it('uses slug as name fallback', async () => {
    await fs.mkdir(REPOSITORIES_DIR, { recursive: true });
    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'unnamed.yaml'),
      [
        'description: No name field',
        'hosts:',
        '  local:',
        '    path: /tmp/unnamed',
      ].join('\n'),
      'utf-8',
    );

    const summaries = listRepoSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('unnamed');
  });

  it('returns multiple summaries sorted by filename', async () => {
    await fs.mkdir(REPOSITORIES_DIR, { recursive: true });

    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'zebra.yaml'),
      'name: Zebra\nhosts:\n  local:\n    path: /z\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'apple.yaml'),
      'name: Apple\nhosts:\n  local:\n    path: /a\n',
      'utf-8',
    );

    const summaries = listRepoSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].name).toBe('Apple');
    expect(summaries[1].name).toBe('Zebra');
  });
});

// ─── executeTool integration ────────────────────────────────────────

describe('executeTool — repos/ integration', () => {
  it('files_write + files_read round-trip for repos/', async () => {
    const yaml = [
      'name: Tool Test Repo',
      'description: Created via executeTool',
      'hosts:',
      '  local:',
      '    path: /tmp/tool-test',
    ].join('\n');

    const writeRaw = await executeTool('file_write', {
      source: 'repos/tool-test',
      content: yaml,
    });
    const writeResult = JSON.parse(writeRaw as string);
    expect(writeResult.status).toBe('created');

    const readRaw = await executeTool('file_read', {
      source: 'repos/tool-test',
    });
    const readResult = JSON.parse(readRaw as string);
    // readFileWithMeta adds line numbers, so check content contains the yaml lines
    expect(readResult.content).toContain('name: Tool Test Repo');
    expect(readResult.content).toContain('description: Created via executeTool');
    expect(readResult.content).toContain('path: /tmp/tool-test');
    expect(readResult.content_hash).toBe(writeResult.content_hash);
  });

  it('files_list for repos/ returns created repos', async () => {
    // Create a repo first
    await executeTool('file_write', {
      source: 'repos/list-test',
      content: 'name: List Test\nhosts:\n  local:\n    path: /tmp/lt\n',
    });

    // files_list uses 'prefix' param, not 'source'
    const listRaw = await executeTool('file_list', { prefix: 'repos/' });
    const listResult = JSON.parse(listRaw as string);

    // files_list returns a flat array of items
    expect(Array.isArray(listResult)).toBe(true);
    const found = listResult.find((i: any) => i.source === 'repos/list-test');
    expect(found).toBeDefined();
    expect(found.name).toBe('List Test');
  });

  it('files_read for non-existent repo returns error', async () => {
    const readRaw = await executeTool('file_read', {
      source: 'repos/nonexistent',
    });
    // Should contain error-like text (not found)
    const text = typeof readRaw === 'string' ? readRaw : JSON.stringify(readRaw);
    expect(text.toLowerCase()).toMatch(/not found|no such file|enoent/i);
  });
});
