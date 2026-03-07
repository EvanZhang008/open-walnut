import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, DAILY_DIR, MEMORY_FILE, PROJECTS_MEMORY_DIR } from '../../src/constants.js';
import { executeTool } from '../../src/agent/tools.js';
import { formatDateKey } from '../../src/core/daily-log.js';
import { computeContentHash } from '../../src/utils/file-ops.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// Helper: parse JSON from tool result
// ═══════════════════════════════════════════════════════════════════

function parseResult(result: unknown): Record<string, unknown> {
  if (typeof result !== 'string') throw new Error('Expected string result');
  return JSON.parse(result);
}

// ═══════════════════════════════════════════════════════════════════
// memory_read
// ═══════════════════════════════════════════════════════════════════

describe('memory_read', () => {
  it('reads global memory with content_hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '# Global\n\nHello world\n', 'utf-8');

    const result = parseResult(await executeTool('memory_read', { target: 'global' }));

    expect(result.content_hash).toHaveLength(12);
    expect(result.total_lines).toBeGreaterThan(0);
    expect(result.content).toContain('Hello world');
    expect(result.showing).toMatch(/1-\d+ of \d+/);
  });

  it('reads project memory with content_hash', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'MEMORY.md'),
      '---\nname: API\ndescription: API project\n---\n\n## Entry\nSome content\n',
      'utf-8',
    );

    const result = parseResult(await executeTool('memory_read', {
      target: 'project',
      project_path: 'work/api',
    }));

    expect(result.content_hash).toHaveLength(12);
    expect(result.content).toContain('API');
    expect(result.content).toContain('Some content');
  });

  it('reads daily log with content_hash', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      '---\nname: today\n---\n\n## 10:00 — test\nDaily entry\n',
      'utf-8',
    );

    const result = parseResult(await executeTool('memory_read', { target: 'daily' }));

    expect(result.content_hash).toHaveLength(12);
    expect(result.content).toContain('Daily entry');
  });

  it('supports offset and limit', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8');

    const result = parseResult(await executeTool('memory_read', {
      target: 'global',
      offset: 2,
      limit: 2,
    }));

    expect(result.content).toContain('line2');
    expect(result.content).toContain('line3');
    expect(result.content).not.toContain('line1');
    expect(result.content).not.toContain('line4');
    expect(result.showing).toBe('2-3 of 6');
    // Hash is still on full content
    expect(result.content_hash).toBe(computeContentHash('line1\nline2\nline3\nline4\nline5\n'));
  });

  it('returns friendly message when file missing', async () => {
    const result = await executeTool('memory_read', { target: 'global' });
    expect(result).toContain('No global memory');
  });

  it('returns friendly message when project missing', async () => {
    const result = await executeTool('memory_read', {
      target: 'project',
      project_path: 'nonexistent/project',
    });
    expect(result).toContain('No memory found');
  });

  it('requires project_path for project target', async () => {
    const result = await executeTool('memory_read', { target: 'project' });
    expect(result).toContain('Error');
    expect(result).toContain('project_path');
  });
});

// ═══════════════════════════════════════════════════════════════════
// memory_edit
// ═══════════════════════════════════════════════════════════════════

describe('memory_edit', () => {
  it('edits global memory with correct hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');
    const hash = computeContentHash('hello world');

    const result = parseResult(await executeTool('memory_edit', {
      target: 'global',
      content_hash: hash,
      old_content: 'world',
      new_content: 'earth',
    }));

    expect(result.status).toBe('updated');
    expect(result.replacements).toBe(1);
    expect(result.content_hash).toHaveLength(12);
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('hello earth');
  });

  it('edits project memory with correct hash', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    const content = '---\nname: API\n---\n\nOld fact here\n';
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('memory_edit', {
      target: 'project',
      project_path: 'work/api',
      content_hash: hash,
      old_content: 'Old fact here',
      new_content: 'New fact here',
    }));

    expect(result.status).toBe('updated');
    const onDisk = fs.readFileSync(path.join(projDir, 'MEMORY.md'), 'utf-8');
    expect(onDisk).toContain('New fact here');
    expect(onDisk).not.toContain('Old fact here');
  });

  it('edits daily log with correct hash', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    const content = '---\nname: today\n---\n\n## 10:00 — test\nWrong info\n';
    fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('memory_edit', {
      target: 'daily',
      content_hash: hash,
      old_content: 'Wrong info',
      new_content: 'Correct info',
    }));

    expect(result.status).toBe('updated');
  });

  it('rejects stale hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');

    const result = await executeTool('memory_edit', {
      target: 'global',
      content_hash: 'wrong_hash_00',
      old_content: 'world',
      new_content: 'earth',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Stale content_hash');
    // File should be unchanged
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('hello world');
  });

  it('rejects missing old_content', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');
    const hash = computeContentHash('hello world');

    const result = await executeTool('memory_edit', {
      target: 'global',
      content_hash: hash,
      old_content: 'nonexistent',
      new_content: 'replacement',
    });

    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('deletes content with empty new_content', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'keep\n\nremove me\n\nkeep too', 'utf-8');
    const hash = computeContentHash('keep\n\nremove me\n\nkeep too');

    const result = parseResult(await executeTool('memory_edit', {
      target: 'global',
      content_hash: hash,
      old_content: 'remove me',
    }));

    expect(result.status).toBe('deleted');
    const onDisk = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(onDisk).not.toContain('remove me');
  });

  it('requires content_hash', async () => {
    const result = await executeTool('memory_edit', {
      target: 'global',
      old_content: 'anything',
      new_content: 'replacement',
    });
    expect(result).toContain('Error');
    expect(result).toContain('content_hash');
  });
});

// ═══════════════════════════════════════════════════════════════════
// memory_write (overwrite mode)
// ═══════════════════════════════════════════════════════════════════

describe('memory_write overwrite', () => {
  it('overwrites global memory with correct hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'old content', 'utf-8');
    const hash = computeContentHash('old content');

    const result = parseResult(await executeTool('memory_write', {
      target: 'global',
      content_hash: hash,
      content: 'brand new content',
    }));

    expect(result.status).toBe('updated');
    expect(result.content_hash).toHaveLength(12);
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('brand new content');
  });

  it('rejects stale hash for global overwrite', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'original', 'utf-8');

    const result = await executeTool('memory_write', {
      target: 'global',
      content_hash: 'wrong_hash_00',
      content: 'new content',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Stale');
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('original');
  });

  it('overwrites project memory section=all', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    const content = '---\nname: API\n---\n\nOld body\n';
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('memory_write', {
      target: 'project',
      project_path: 'work/api',
      content_hash: hash,
      content: '---\nname: API v2\n---\n\nNew body\n',
    }));

    expect(result.status).toBe('updated');
    const onDisk = fs.readFileSync(path.join(projDir, 'MEMORY.md'), 'utf-8');
    expect(onDisk).toContain('API v2');
    expect(onDisk).toContain('New body');
  });

  it('overwrites project memory section=summary (preserves body)', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    const content = '---\nname: Old Name\ndescription: Old desc\n---\n\n## Log entry\nKeep this\n';
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('memory_write', {
      target: 'project',
      project_path: 'work/api',
      content_hash: hash,
      section: 'summary',
      name: 'New Name',
      description: 'New desc',
    }));

    expect(result.status).toBe('updated');
    const onDisk = fs.readFileSync(path.join(projDir, 'MEMORY.md'), 'utf-8');
    expect(onDisk).toContain('New Name');
    expect(onDisk).toContain('New desc');
    expect(onDisk).toContain('Keep this'); // body preserved
  });

  it('overwrites project memory section=body (preserves frontmatter)', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    const content = '---\nname: API\ndescription: My API\n---\n\nOld body content\n';
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('memory_write', {
      target: 'project',
      project_path: 'work/api',
      content_hash: hash,
      section: 'body',
      content: '\n## New entry\nFresh content\n',
    }));

    expect(result.status).toBe('updated');
    const onDisk = fs.readFileSync(path.join(projDir, 'MEMORY.md'), 'utf-8');
    expect(onDisk).toContain('name: API'); // frontmatter preserved
    expect(onDisk).toContain('Fresh content');
    expect(onDisk).not.toContain('Old body content');
  });

  it('requires content_hash for overwrite mode', async () => {
    const result = await executeTool('memory_write', {
      target: 'global',
      content: 'new content',
    });
    expect(result).toContain('Error');
    expect(result).toContain('content_hash');
  });
});

// ═══════════════════════════════════════════════════════════════════
// memory_write (append mode)
// ═══════════════════════════════════════════════════════════════════

describe('memory_write append', () => {
  it('appends to project memory + daily log', async () => {
    const result = parseResult(await executeTool('memory_write', {
      target: 'project',
      mode: 'append',
      project_path: 'work/api',
      content: 'Added new API endpoint',
    }));

    expect(result.status).toBe('saved');
    expect(result.written_to).toContain('project');
    expect(result.written_to).toContain('daily');

    // Verify project memory file
    const projectMemPath = path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'MEMORY.md');
    expect(fs.existsSync(projectMemPath)).toBe(true);
    expect(fs.readFileSync(projectMemPath, 'utf-8')).toContain('Added new API endpoint');

    // Verify daily log
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(true);
    expect(fs.readFileSync(dailyLogPath, 'utf-8')).toContain('Added new API endpoint');
  });

  it('appends to daily log only (target=daily)', async () => {
    const result = await executeTool('memory_write', {
      target: 'daily',
      mode: 'append',
      content: 'Daily-only observation',
    });
    const parsed = parseResult(result);
    expect(parsed.status).toBe('saved');
    expect(parsed.written_to).toContain('daily');

    // Verify daily log
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.readFileSync(dailyLogPath, 'utf-8')).toContain('Daily-only observation');
  });

  it('rejects append to global memory', async () => {
    const result = await executeTool('memory_write', {
      target: 'global',
      mode: 'append',
      content: 'Should fail',
    });
    expect(result).toContain('Error');
    expect(result).toContain('does not support append');
  });

  it('does not require content_hash for append', async () => {
    const result = parseResult(await executeTool('memory_write', {
      target: 'project',
      mode: 'append',
      project_path: 'work/test',
      content: 'No hash needed',
    }));
    expect(result.status).toBe('saved');
  });

  it('multiple appends accumulate', async () => {
    await executeTool('memory_write', {
      target: 'project',
      mode: 'append',
      project_path: 'myproject',
      content: 'First entry: project setup',
    });

    await executeTool('memory_write', {
      target: 'project',
      mode: 'append',
      project_path: 'myproject',
      content: 'Second entry: added tests',
    });

    const result = parseResult(await executeTool('memory_read', {
      target: 'project',
      project_path: 'myproject',
    }));

    expect(result.content).toContain('First entry: project setup');
    expect(result.content).toContain('Second entry: added tests');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Chained operations: read → edit → edit (hash chain)
// ═══════════════════════════════════════════════════════════════════

describe('chained operations', () => {
  it('read → edit → edit with hash chain', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'aaa bbb ccc', 'utf-8');

    // Read
    const r0 = parseResult(await executeTool('memory_read', { target: 'global' }));
    expect(r0.content_hash).toBeTruthy();

    // Edit 1
    const r1 = parseResult(await executeTool('memory_edit', {
      target: 'global',
      content_hash: r0.content_hash as string,
      old_content: 'aaa',
      new_content: 'AAA',
    }));
    expect(r1.status).toBe('updated');
    expect(r1.content_hash).not.toBe(r0.content_hash);

    // Edit 2 using hash from Edit 1
    const r2 = parseResult(await executeTool('memory_edit', {
      target: 'global',
      content_hash: r1.content_hash as string,
      old_content: 'bbb',
      new_content: 'BBB',
    }));
    expect(r2.status).toBe('updated');

    // Verify final content
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('AAA BBB ccc');
  });

  it('stale hash breaks the chain', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'original', 'utf-8');

    const r0 = parseResult(await executeTool('memory_read', { target: 'global' }));

    // External modification
    fs.writeFileSync(MEMORY_FILE, 'modified externally', 'utf-8');

    // Edit with old hash should fail
    const r1 = await executeTool('memory_edit', {
      target: 'global',
      content_hash: r0.content_hash as string,
      old_content: 'original',
      new_content: 'new',
    });
    expect(r1).toContain('Stale content_hash');
  });

  it('read → overwrite with hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'old global content', 'utf-8');

    const r0 = parseResult(await executeTool('memory_read', { target: 'global' }));

    const r1 = parseResult(await executeTool('memory_write', {
      target: 'global',
      content_hash: r0.content_hash as string,
      content: 'completely new content',
    }));

    expect(r1.status).toBe('updated');
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('completely new content');
  });
});
