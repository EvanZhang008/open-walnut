import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, DAILY_DIR, MEMORY_FILE, PROJECTS_MEMORY_DIR } from '../../src/constants.js';
import { buildMemoryContext } from '../../src/agent/context.js';
import { formatDateKey } from '../../src/core/daily-log.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('buildMemoryContext', () => {
  it('returns placeholder text when no memory exists', () => {
    const result = buildMemoryContext();
    expect(result).toContain('(No global memory yet.)');
    expect(result).toContain('(No projects yet.)');
    expect(result).toContain('(No recent activity.)');
  });

  it('contains all section headers', () => {
    const result = buildMemoryContext();
    expect(result).toContain('## Task Categories & Projects');
    expect(result).toContain('## Your long-term memory');
    expect(result).toContain('## Your projects');
    expect(result).toContain('## Recent activity');
  });

  it('includes global MEMORY.md content when file exists', () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '# My Preferences\n\nI prefer dark mode and TypeScript.', 'utf-8');

    const result = buildMemoryContext();
    expect(result).toContain('# My Preferences');
    expect(result).toContain('I prefer dark mode and TypeScript.');
    expect(result).not.toContain('(No global memory yet.)');
  });

  it('includes project summaries from all projects', () => {
    // Create two project MEMORY.md files
    const proj1Dir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api');
    fs.mkdirSync(proj1Dir, { recursive: true });
    fs.writeFileSync(path.join(proj1Dir, 'MEMORY.md'), `---
name: API Service
description: REST API for the platform
---
`, 'utf-8');

    const proj2Dir = path.join(PROJECTS_MEMORY_DIR, 'personal', 'blog');
    fs.mkdirSync(proj2Dir, { recursive: true });
    fs.writeFileSync(path.join(proj2Dir, 'MEMORY.md'), `---
name: Blog
description: Personal blog project
---
`, 'utf-8');

    const result = buildMemoryContext();
    expect(result).toContain('**API Service**');
    expect(result).toContain('work/api');
    expect(result).toContain('REST API for the platform');
    expect(result).toContain('**Blog**');
    expect(result).toContain('personal/blog');
    expect(result).toContain('Personal blog project');
    expect(result).not.toContain('(No projects yet.)');
  });

  it('includes recent daily log content', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    const logContent = `# Daily Log: ${dateKey}\n\n## 10:30 — agent\nWorked on API endpoints.\n\n`;
    fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), logContent, 'utf-8');

    const result = buildMemoryContext();
    expect(result).toContain('Worked on API endpoints.');
    expect(result).not.toContain('(No recent activity.)');
  });

  it('respects token budget - large daily logs get truncated', () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    // Create daily logs for several days with large content
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = formatDateKey(d);
      // Each log has ~500 words = ~650 tokens
      const bigContent = `# Daily Log: ${dateKey}\n\n## 10:00 — agent\n${'Lorem ipsum dolor sit amet. '.repeat(100)}\n\n`;
      fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), bigContent, 'utf-8');
    }

    // With a small budget, only some logs should be included
    const smallBudget = buildMemoryContext(2000);
    const largeBudget = buildMemoryContext(50000);

    // Small budget should have fewer logs than large budget
    const smallLogCount = (smallBudget.match(/Daily Log:/g) || []).length;
    const largeLogCount = (largeBudget.match(/Daily Log:/g) || []).length;
    expect(largeLogCount).toBeGreaterThan(smallLogCount);
  });

  it('combines all sections correctly', () => {
    // Set up all three types of data
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, 'Global knowledge here.', 'utf-8');

    const projDir = path.join(PROJECTS_MEMORY_DIR, 'myproject');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), `---
name: My Project
description: Test project
---
`, 'utf-8');

    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      `# Daily Log: ${dateKey}\n\n## 09:00 — agent\nDid some work.\n\n`,
      'utf-8',
    );

    const result = buildMemoryContext();

    // All three sections should have real content
    expect(result).toContain('Global knowledge here.');
    expect(result).toContain('**My Project**');
    expect(result).toContain('Did some work.');

    // No placeholders should appear
    expect(result).not.toContain('(No global memory yet.)');
    expect(result).not.toContain('(No projects yet.)');
    expect(result).not.toContain('(No recent activity.)');
  });
});
