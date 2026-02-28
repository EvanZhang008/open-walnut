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

  it('returns summary + tail + parent summaries', () => {
    // Create parent first
    ensureProjectDir('work');
    updateProjectSummary('work', 'Work', 'Work-related projects');

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
    // Should be the last 5 entries
    expect(result.tail[0]).toContain('Entry');
  });
});

describe('updateProjectSummary', () => {
  it('rewrites header and preserves logs', () => {
    ensureProjectDir('work/api');
    appendProjectMemory('work/api', 'Some work done', 'session');

    updateProjectSummary('work/api', 'API Service', 'RESTful API for the platform');

    const content = getProjectMemory('work/api')!;
    expect(content).toContain('name: API Service');
    expect(content).toContain('description: RESTful API for the platform');
    expect(content).toContain('Some work done');
  });

  it('returns parent summaries', () => {
    ensureProjectDir('work');
    updateProjectSummary('work', 'Work', 'Work projects');

    ensureProjectDir('work/api');
    const result = updateProjectSummary('work/api', 'API', 'API service');
    expect(result.parentSummaries).toHaveLength(1);
    expect(result.parentSummaries[0].name).toBe('Work');
  });

  it('handles multiline description without corrupting YAML', () => {
    ensureProjectDir('life/tax');
    updateProjectSummary('life/tax', 'Tax', 'Line one\nLine two\nLine three');

    // append after update_summary must see the correct name
    const result = appendProjectMemory('life/tax', 'Filed taxes', 'agent');
    expect(result.summary.name).toBe('Tax');
    expect(result.summary.description).toContain('Line one');
  });

  it('handles description with YAML-special characters', () => {
    ensureProjectDir('work/svc');
    updateProjectSummary('work/svc', 'Service', 'has: colons and "quotes"');

    const summary = getProjectSummary('work/svc');
    expect(summary!.name).toBe('Service');
    expect(summary!.description).toBe('has: colons and "quotes"');
  });
});

describe('getAllProjectSummaries', () => {
  it('finds nested MEMORY.md files', () => {
    ensureProjectDir('work');
    updateProjectSummary('work', 'Work', 'Work stuff');

    ensureProjectDir('work/api');
    updateProjectSummary('work/api', 'API', 'API service');

    ensureProjectDir('personal');
    updateProjectSummary('personal', 'Personal', 'Personal projects');

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
  it('returns full content of project MEMORY.md', () => {
    ensureProjectDir('work');
    appendProjectMemory('work', 'Test content', 'test');

    const content = getProjectMemory('work');
    expect(content).not.toBeNull();
    expect(content).toContain('Test content');
  });

  it('returns null for non-existent project', () => {
    const content = getProjectMemory('nonexistent');
    expect(content).toBeNull();
  });
});

describe('getProjectSummary', () => {
  it('reads project header', () => {
    ensureProjectDir('work');
    updateProjectSummary('work', 'Work Hub', 'All work projects');

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
  it('replaces matched text with new content', () => {
    appendProjectMemory('work/api', 'Old fact about the API', 'agent');
    const result = editProjectMemory('work/api', 'Old fact about the API', 'Corrected fact about the API');
    expect(result.oldContent).toBe('Old fact about the API');
    expect(result.newContent).toBe('Corrected fact about the API');

    const content = getProjectMemory('work/api')!;
    expect(content).toContain('Corrected fact about the API');
    expect(content).not.toContain('Old fact about the API');
  });

  it('deletes matched text when new_content is empty', () => {
    appendProjectMemory('work/api', 'Keep this entry', 'agent');
    appendProjectMemory('work/api', 'Delete this entry', 'agent');
    editProjectMemory('work/api', 'Delete this entry');

    const content = getProjectMemory('work/api')!;
    expect(content).toContain('Keep this entry');
    expect(content).not.toContain('Delete this entry');
  });

  it('cleans up triple+ blank lines after deletion', () => {
    appendProjectMemory('work/api', 'First entry', 'agent');
    appendProjectMemory('work/api', 'Middle entry', 'agent');
    appendProjectMemory('work/api', 'Last entry', 'agent');

    // Delete the middle entry content — the ## header + content block
    const content = getProjectMemory('work/api')!;
    const middleMatch = content.match(/## .+? — agent \[work\/api\]\nMiddle entry\n\n/);
    expect(middleMatch).not.toBeNull();
    editProjectMemory('work/api', middleMatch![0]);

    const updated = getProjectMemory('work/api')!;
    expect(updated).not.toContain('Middle entry');
    // No triple blank lines
    expect(updated).not.toMatch(/\n{3,}/);
  });

  it('throws when old_content not found', () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    expect(() => editProjectMemory('work/api', 'nonexistent text', 'new')).toThrow('not found');
  });

  it('throws when old_content matches multiple locations', () => {
    appendProjectMemory('work/api', 'duplicate text here', 'agent');
    appendProjectMemory('work/api', 'duplicate text here', 'agent');
    expect(() => editProjectMemory('work/api', 'duplicate text here', 'fixed')).toThrow('2 locations');
  });

  it('throws for non-existent project', () => {
    expect(() => editProjectMemory('nonexistent', 'old', 'new')).toThrow('No memory file found');
  });

  it('throws when old_content is empty string', () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    expect(() => editProjectMemory('work/api', '', 'new')).toThrow('cannot be empty');
  });

  it('preserves YAML frontmatter when editing log content', () => {
    appendProjectMemory('work/api', 'Some content', 'agent');
    updateProjectSummary('work/api', 'API Service', 'Our API');
    editProjectMemory('work/api', 'Some content', 'Updated content');

    const content = getProjectMemory('work/api')!;
    expect(content).toContain('name: API Service');
    expect(content).toContain('Updated content');
  });
});

describe('getParentSummaries', () => {
  it('returns empty for top-level project', () => {
    ensureProjectDir('work');
    const parents = getParentSummaries('work');
    expect(parents).toEqual([]);
  });

  it('returns parent summaries for nested project', () => {
    ensureProjectDir('work');
    updateProjectSummary('work', 'Work', 'Work category');

    ensureProjectDir('work/api');
    const parents = getParentSummaries('work/api');
    expect(parents).toHaveLength(1);
    expect(parents[0].name).toBe('Work');
    expect(parents[0].path).toBe('work');
  });
});
