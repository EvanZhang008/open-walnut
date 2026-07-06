import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, DAILY_DIR, MEMORY_FILE, PROJECTS_MEMORY_DIR, GLOBAL_SKILLS_DIR } from '../../src/constants.js';
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
// files_read (memory sources)
// ═══════════════════════════════════════════════════════════════════

describe('files_read memory sources', () => {
  it('reads global memory with content_hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '# Global\n\nHello world\n', 'utf-8');

    const result = parseResult(await executeTool('file_read', { source: 'memory/global' }));

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

    const result = parseResult(await executeTool('file_read', {
      source: 'memory/project/work/api',
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

    const result = parseResult(await executeTool('file_read', { source: 'memory/daily' }));

    expect(result.content_hash).toHaveLength(12);
    expect(result.content).toContain('Daily entry');
  });

  it('supports offset and limit', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8');

    const result = parseResult(await executeTool('file_read', {
      source: 'memory/global',
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

  it('creates default global memory when file missing', async () => {
    // files_read with memory/global auto-creates the file via ensureMemoryFile()
    const result = parseResult(await executeTool('file_read', { source: 'memory/global' }));
    expect(result.content_hash).toHaveLength(12);
    expect(result.content).toBeDefined();
  });

  it('returns error when project memory missing', async () => {
    const result = await executeTool('file_read', {
      source: 'memory/project/nonexistent/project',
    });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════
// files_edit (memory sources)
// ═══════════════════════════════════════════════════════════════════

describe('files_edit memory sources', () => {
  it('edits global memory with correct hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');
    const hash = computeContentHash('hello world');

    const result = parseResult(await executeTool('file_edit', {
      source: 'memory/global',
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

    const result = parseResult(await executeTool('file_edit', {
      source: 'memory/project/work/api',
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

    const result = parseResult(await executeTool('file_edit', {
      source: 'memory/daily',
      content_hash: hash,
      old_content: 'Wrong info',
      new_content: 'Correct info',
    }));

    expect(result.status).toBe('updated');
  });

  it('rejects stale hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');

    const result = await executeTool('file_edit', {
      source: 'memory/global',
      content_hash: 'wrong_hash_00',
      old_content: 'world',
      new_content: 'earth',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Stale');
    // File should be unchanged
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('hello world');
  });

  it('rejects missing old_content', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');
    const hash = computeContentHash('hello world');

    const result = await executeTool('file_edit', {
      source: 'memory/global',
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

    const result = parseResult(await executeTool('file_edit', {
      source: 'memory/global',
      content_hash: hash,
      old_content: 'remove me',
    }));

    expect(result.status).toBe('deleted');
    const onDisk = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(onDisk).not.toContain('remove me');
  });

  it('requires content_hash for memory sources', async () => {
    const result = await executeTool('file_edit', {
      source: 'memory/global',
      old_content: 'anything',
      new_content: 'replacement',
    });
    expect(result).toContain('Error');
    expect(result).toContain('content_hash');
  });
});

// ═══════════════════════════════════════════════════════════════════
// files_write overwrite (memory sources)
// ═══════════════════════════════════════════════════════════════════

describe('files_write overwrite memory sources', () => {
  it('overwrites global memory with correct hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'old content', 'utf-8');
    const hash = computeContentHash('old content');

    const result = parseResult(await executeTool('file_write', {
      source: 'memory/global',
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

    const result = await executeTool('file_write', {
      source: 'memory/global',
      content_hash: 'wrong_hash_00',
      content: 'new content',
    });

    expect(result).toContain('Error');
    expect(result).toContain('Stale');
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('original');
  });

  it('overwrites project memory', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(projDir, { recursive: true });
    const content = '---\nname: API\n---\n\nOld body\n';
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), content, 'utf-8');
    const hash = computeContentHash(content);

    const result = parseResult(await executeTool('file_write', {
      source: 'memory/project/work/api',
      content_hash: hash,
      content: '---\nname: API v2\n---\n\nNew body\n',
    }));

    expect(result.status).toBe('updated');
    const onDisk = fs.readFileSync(path.join(projDir, 'MEMORY.md'), 'utf-8');
    expect(onDisk).toContain('API v2');
    expect(onDisk).toContain('New body');
  });

  it('requires content_hash for overwrite mode', async () => {
    const result = await executeTool('file_write', {
      source: 'memory/global',
      content: 'new content',
    });
    expect(result).toContain('Error');
    expect(result).toContain('content_hash');
  });
});

// ═══════════════════════════════════════════════════════════════════
// files_write append (memory sources)
// ═══════════════════════════════════════════════════════════════════

// memory/projects/ is retired as a write target (2026-07 unification):
// project appends route to skills/<category>/<project>/history/log.md
// (or the category overview log). Tests create the target skill first.
function seedSkill(category: string, name: string): void {
  const dir = path.join(GLOBAL_SKILLS_DIR, category, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`, 'utf-8');
}

describe('files_write append memory sources', () => {
  it('appends to skill history + daily log', async () => {
    seedSkill('work', 'api');
    const result = parseResult(await executeTool('file_write', {
      source: 'memory/project/work/api',
      mode: 'append',
      content: 'Added new API endpoint',
    }));

    expect(result.status).toBe('saved');
    expect(result.written_to).toContain('skill-history');
    expect(result.written_to).toContain('daily');

    // Verify skill history log
    const historyLog = path.join(GLOBAL_SKILLS_DIR, 'work', 'api', 'history', 'log.md');
    expect(fs.existsSync(historyLog)).toBe(true);
    expect(fs.readFileSync(historyLog, 'utf-8')).toContain('Added new API endpoint');

    // Legacy memory/projects/ must NOT be written
    expect(fs.existsSync(path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'MEMORY.md'))).toBe(false);

    // Verify daily log
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(true);
    expect(fs.readFileSync(dailyLogPath, 'utf-8')).toContain('Added new API endpoint');
  });

  it('project append without a matching skill errors (daily still written)', async () => {
    const result = await executeTool('file_write', {
      source: 'memory/project/work/ghost',
      mode: 'append',
      content: 'Orphan entry',
    });
    expect(result).toContain('Error');
    expect(result).toContain('No skill history target');

    // Daily log got the entry regardless
    const dailyLogPath = path.join(DAILY_DIR, `${formatDateKey()}.md`);
    expect(fs.readFileSync(dailyLogPath, 'utf-8')).toContain('Orphan entry');
  });

  it('project append falls back to the category overview skill', async () => {
    seedSkill('work', 'overview');
    const result = parseResult(await executeTool('file_write', {
      source: 'memory/project/work/side-quest',
      mode: 'append',
      content: 'Overview-routed entry',
    }));
    expect(result.status).toBe('saved');
    expect(result.written_to).toContain('skill-history');

    const overviewLog = path.join(GLOBAL_SKILLS_DIR, 'work', 'overview', 'history', 'log.md');
    expect(fs.readFileSync(overviewLog, 'utf-8')).toContain('Overview-routed entry');
  });

  it('appends to daily log only (source=memory/daily)', async () => {
    const result = await executeTool('file_write', {
      source: 'memory/daily',
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
    const result = await executeTool('file_write', {
      source: 'memory/global',
      mode: 'append',
      content: 'Should fail',
    });
    expect(result).toContain('Error');
    expect(result).toContain('does not support append');
  });

  it('does not require content_hash for append', async () => {
    seedSkill('work', 'test');
    const result = parseResult(await executeTool('file_write', {
      source: 'memory/project/work/test',
      mode: 'append',
      content: 'No hash needed',
    }));
    expect(result.status).toBe('saved');
  });

  it('multiple appends accumulate', async () => {
    seedSkill('myproject', 'myproject');
    await executeTool('file_write', {
      source: 'memory/project/myproject',
      mode: 'append',
      content: 'First entry: project setup',
    });

    await executeTool('file_write', {
      source: 'memory/project/myproject',
      mode: 'append',
      content: 'Second entry: added tests',
    });

    const historyLog = path.join(GLOBAL_SKILLS_DIR, 'myproject', 'myproject', 'history', 'log.md');
    const content = fs.readFileSync(historyLog, 'utf-8');
    expect(content).toContain('First entry: project setup');
    expect(content).toContain('Second entry: added tests');
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
    const r0 = parseResult(await executeTool('file_read', { source: 'memory/global' }));
    expect(r0.content_hash).toBeTruthy();

    // Edit 1
    const r1 = parseResult(await executeTool('file_edit', {
      source: 'memory/global',
      content_hash: r0.content_hash as string,
      old_content: 'aaa',
      new_content: 'AAA',
    }));
    expect(r1.status).toBe('updated');
    expect(r1.content_hash).not.toBe(r0.content_hash);

    // Edit 2 using hash from Edit 1
    const r2 = parseResult(await executeTool('file_edit', {
      source: 'memory/global',
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

    const r0 = parseResult(await executeTool('file_read', { source: 'memory/global' }));

    // External modification
    fs.writeFileSync(MEMORY_FILE, 'modified externally', 'utf-8');

    // Edit with old hash should fail
    const r1 = await executeTool('file_edit', {
      source: 'memory/global',
      content_hash: r0.content_hash as string,
      old_content: 'original',
      new_content: 'new',
    });
    expect(r1).toContain('Stale');
  });

  it('read → overwrite with hash', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'old global content', 'utf-8');

    const r0 = parseResult(await executeTool('file_read', { source: 'memory/global' }));

    const r1 = parseResult(await executeTool('file_write', {
      source: 'memory/global',
      content_hash: r0.content_hash as string,
      content: 'completely new content',
    }));

    expect(r1.status).toBe('updated');
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('completely new content');
  });
});
