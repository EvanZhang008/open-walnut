import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  parseProjectMemory,
  ensureProjectDir,
  appendProjectMemory,
  updateProjectSummary,
  editProjectMemory,
  getAllProjectSummaries,
  getProjectMemory,
  getProjectSummary,
  getParentSummaries,
} from '../../src/core/project-memory.js';
import { WALNUT_HOME, PROJECTS_MEMORY_DIR } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('parseProjectMemory', () => {
  it('parses YAML frontmatter + log entries', () => {
    const content = `---
name: My Project
description: A test project
---
## 2025-01-15 14:30 — session [work/api]
Did some work on the API

## 2025-01-16 09:00 — agent [work/api]
Added more features
`;
    const parsed = parseProjectMemory(content);
    expect(parsed.name).toBe('My Project');
    expect(parsed.description).toBe('A test project');
    expect(parsed.logs).toHaveLength(2);
    expect(parsed.logs[0].date).toBe('2025-01-15');
    expect(parsed.logs[0].time).toBe('14:30');
    expect(parsed.logs[0].source).toBe('session');
    expect(parsed.logs[0].projectPath).toBe('work/api');
    expect(parsed.logs[0].content).toBe('Did some work on the API');
    expect(parsed.logs[1].date).toBe('2025-01-16');
    expect(parsed.logs[1].content).toBe('Added more features');
  });

  it('handles missing frontmatter', () => {
    const content = '## 2025-01-15 14:30 — session [work]\nSome work\n';
    const parsed = parseProjectMemory(content);
    expect(parsed.name).toBe('Unnamed Project');
    expect(parsed.description).toBe('');
    expect(parsed.logs).toHaveLength(1);
  });

  it('handles entries without projectPath', () => {
    const content = `---
name: Test
description: test
---
## 2025-01-15 14:30 — agent
Content here
`;
    const parsed = parseProjectMemory(content);
    expect(parsed.logs).toHaveLength(1);
    expect(parsed.logs[0].projectPath).toBeUndefined();
  });
});

describe('ensureProjectDir', () => {
  it('creates directory and MEMORY.md', () => {
    ensureProjectDir('work/api');
    const dirPath = path.join(PROJECTS_MEMORY_DIR, 'work/api');
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(path.join(dirPath, 'MEMORY.md'))).toBe(true);
  });

  it('rejects paths deeper than 3 levels', () => {
    expect(() => ensureProjectDir('a/b/c/d')).toThrow('exceeds max depth');
  });

  it('accepts paths with 3 levels', () => {
    expect(() => ensureProjectDir('a/b/c')).not.toThrow();
    const dirPath = path.join(PROJECTS_MEMORY_DIR, 'a/b/c');
    expect(fs.existsSync(dirPath)).toBe(true);
  });

  it('does not overwrite existing MEMORY.md', () => {
    ensureProjectDir('work');
    const memFile = path.join(PROJECTS_MEMORY_DIR, 'work', 'MEMORY.md');
    fs.writeFileSync(memFile, 'Custom content', 'utf-8');
    ensureProjectDir('work');
    const content = fs.readFileSync(memFile, 'utf-8');
    expect(content).toBe('Custom content');
  });
});

describe('appendProjectMemory', () => {
  it('creates new project and appends entry', () => {
    const result = appendProjectMemory('work/api', 'Built the REST endpoints', 'session');
    expect(result.summary.name).toBe('Unnamed Project');
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toBe('Built the REST endpoints');
  });

  it('returns summary + tail + parent summaries', async () => {
    // Create parent first
    ensureProjectDir('work');
    await updateProjectSummary('work', 'Work', 'Work-related projects');

    const result = appendProjectMemory('work/api', 'Entry 1', 'test');
    expect(result.summary).toBeDefined();
    expect(result.tail).toBeDefined();
    expect(result.parentSummaries).toHaveLength(1);
    expect(result.parentSummaries[0].name).toBe('Work');
  });

  it('appends multiple entries and returns last 5 tail', () => {
    for (let i = 0; i < 7; i++) {
      appendProjectMemory('work/api', `Entry ${i}`, 'test');
    }
    const result = appendProjectMemory('work/api', 'Entry 7', 'test');
    expect(result.tail).toHaveLength(5);
    expect(result.tail[0]).toContain('Entry');
  });
});

describe('updateProjectSummary', () => {
  it('rewrites header and preserves logs', async () => {
    ensureProjectDir('work/api');
    appendProjectMemory('work/api', 'Some work done', 'session');

    await updateProjectSummary('work/api', 'API Service', 'RESTful API for the platform');

    const result = getProjectMemory('work/api')!;
    expect(result.content).toContain('name: API Service');
    expect(result.content).toContain('description: RESTful API for the platform');
    expect(result.content).toContain('Some work done');
  });

  it('returns parent summaries and content hash', async () => {
    ensureProjectDir('work');
    await updateProjectSummary('work', 'Work', 'Work projects');

    ensureProjectDir('work/api');
    const result = await updateProjectSummary('work/api', 'API', 'API service');
    expect(result.parentSummaries).toHaveLength(1);
    expect(result.parentSummaries[0].name).toBe('Work');
    expect(result.contentHash).toHaveLength(12);
  });

  it('handles multiline description without corrupting YAML', async () => {
    ensureProjectDir('life/tax');
    await updateProjectSummary('life/tax', 'Tax', 'Line one\nLine two\nLine three');

    const result = appendProjectMemory('life/tax', 'Filed taxes', 'agent');
    expect(result.summary.name).toBe('Tax');
    expect(result.summary.description).toContain('Line one');
  });

  it('handles description with YAML-special characters', async () => {
    ensureProjectDir('work/svc');
    await updateProjectSummary('work/svc', 'Service', 'has: colons and "quotes"');

    const summary = getProjectSummary('work/svc');
    expect(summary!.name).toBe('Service');
    expect(summary!.description).toBe('has: colons and "quotes"');
  });
});

describe('getAllProjectSummaries', () => {
  it('finds nested MEMORY.md files', async () => {
    ensureProjectDir('work');
    await updateProjectSummary('work', 'Work', 'Work stuff');

    ensureProjectDir('work/api');
    await updateProjectSummary('work/api', 'API', 'API service');

    ensureProjectDir('personal');
    await updateProjectSummary('personal', 'Personal', 'Personal projects');

    const summaries = getAllProjectSummaries();
    expect(summaries.length).toBe(3);

    const names = summaries.map((s) => s.name);
    expect(names).toContain('Work');
    expect(names).toContain('API');
    expect(names).toContain('Personal');
  });

  it('returns empty when no projects exist', () => {
    fs.mkdirSync(PROJECTS_MEMORY_DIR, { recursive: true });
    const summaries = getAllProjectSummaries();
    expect(summaries).toEqual([]);
  });
});

describe('getProjectMemory', () => {
  it('returns content and hash of project MEMORY.md', () => {
    ensureProjectDir('work');
    appendProjectMemory('work', 'Test content', 'test');

    const result = getProjectMemory('work');
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Test content');
    expect(result!.contentHash).toHaveLength(12);
  });

  it('returns null for non-existent project', () => {
    const result = getProjectMemory('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getProjectSummary', () => {
  it('reads project header', async () => {
    ensureProjectDir('work');
    await updateProjectSummary('work', 'Work Hub', 'All work projects');

    const summary = getProjectSummary('work');
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe('Work Hub');
    expect(summary!.description).toBe('All work projects');
  });

  it('returns null for non-existent project', () => {
    expect(getProjectSummary('nonexistent')).toBeNull();
  });
});

describe('editProjectMemory', () => {
  it('replaces matched text with new content', async () => {
    appendProjectMemory('work/api', 'Old fact about the API', 'agent');
    const result = await editProjectMemory('work/api', 'Old fact about the API', 'Corrected fact about the API');
    expect(result.replacements).toBe(1);
    expect(result.contentHash).toHaveLength(12);

    const content = getProjectMemory('work/api')!;
    expect(content.content).toContain('Corrected fact about the API');
    expect(content.content).not.toContain('Old fact about the API');
  });

  it('deletes matched text when new_content is empty', async () => {
    appendProjectMemory('work/api', 'Keep this entry', 'agent');
    appendProjectMemory('work/api', 'Delete this entry', 'agent');
    await editProjectMemory('work/api', 'Delete this entry', '');

    const content = getProjectMemory('work/api')!;
    expect(content.content).toContain('Keep this entry');
    expect(content.content).not.toContain('Delete this entry');
  });

  it('cleans up triple+ blank lines after deletion', async () => {
    appendProjectMemory('work/api', 'First entry', 'agent');
    appendProjectMemory('work/api', 'Middle entry', 'agent');
    appendProjectMemory('work/api', 'Last entry', 'agent');

    const content = getProjectMemory('work/api')!;
    const middleMatch = content.content.match(/## .+? — agent \[work\/api\]\nMiddle entry\n\n/);
    expect(middleMatch).not.toBeNull();
    await editProjectMemory('work/api', middleMatch![0], '');

    const updated = getProjectMemory('work/api')!;
    expect(updated.content).not.toContain('Middle entry');
    expect(updated.content).not.toMatch(/\n{3,}/);
  });

  it('rejects when old_content not found', async () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    await expect(editProjectMemory('work/api', 'nonexistent text', 'new')).rejects.toThrow('not found');
  });

  it('rejects when old_content matches multiple locations', async () => {
    appendProjectMemory('work/api', 'duplicate text here', 'agent');
    appendProjectMemory('work/api', 'duplicate text here', 'agent');
    await expect(editProjectMemory('work/api', 'duplicate text here', 'fixed')).rejects.toThrow('matches');
  });

  it('rejects for non-existent project', async () => {
    await expect(editProjectMemory('nonexistent', 'old', 'new')).rejects.toThrow();
  });

  it('rejects when old_content is empty string', async () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    await expect(editProjectMemory('work/api', '', 'new')).rejects.toThrow('cannot be empty');
  });

  it('preserves YAML frontmatter when editing log content', async () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    await updateProjectSummary('work/api', 'API Service', 'Our API');
    await editProjectMemory('work/api', 'Some content', 'Updated content');

    const content = getProjectMemory('work/api')!;
    expect(content.content).toContain('name: API Service');
    expect(content.content).toContain('Updated content');
  });
});

describe('getParentSummaries', () => {
  it('returns empty for top-level project', () => {
    ensureProjectDir('work');
    const parents = getParentSummaries('work');
    expect(parents).toEqual([]);
  });

  it('returns parent summaries for nested project', async () => {
    ensureProjectDir('work');
    await updateProjectSummary('work', 'Work', 'Work category');

    ensureProjectDir('work/api');
    const parents = getParentSummaries('work/api');
    expect(parents).toHaveLength(1);
    expect(parents[0].name).toBe('Work');
    expect(parents[0].path).toBe('work');
  });
});
