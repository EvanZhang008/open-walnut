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

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('memory tool integration', () => {
  it('append with project_path creates both daily log and project MEMORY.md', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Added new API endpoint',
      project_path: 'work/api',
    });

    // Verify daily log file was created
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(true);
    const dailyContent = fs.readFileSync(dailyLogPath, 'utf-8');
    expect(dailyContent).toContain('Added new API endpoint');

    // Verify project MEMORY.md was created
    const projectMemPath = path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'MEMORY.md');
    expect(fs.existsSync(projectMemPath)).toBe(true);
    const projContent = fs.readFileSync(projectMemPath, 'utf-8');
    expect(projContent).toContain('Added new API endpoint');
  });

  it('append without project_path creates only daily log', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'General observation about the codebase',
    });

    // Verify daily log exists
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(true);
    const dailyContent = fs.readFileSync(dailyLogPath, 'utf-8');
    expect(dailyContent).toContain('General observation about the codebase');

    // No project directories should have been created
    const projectsDir = PROJECTS_MEMORY_DIR;
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir);
      expect(entries).toHaveLength(0);
    }
  });

  it('append then read round-trips project memory content', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'The auth module uses JWT tokens',
      project_path: 'work/auth',
    });

    const result = await executeTool('memory', {
      action: 'read',
      project_path: 'work/auth',
    });

    expect(result).toContain('The auth module uses JWT tokens');
  });

  it('update_summary then read shows updated name/description with preserved log entries', async () => {
    // First append some content
    await executeTool('memory', {
      action: 'append',
      content: 'Implemented user login',
      project_path: 'work/auth',
    });

    // Update the summary
    await executeTool('memory', {
      action: 'update_summary',
      project_path: 'work/auth',
      name: 'Auth Service',
      description: 'Authentication and authorization module',
    });

    // Read back and verify both summary and log are present
    const result = await executeTool('memory', {
      action: 'read',
      project_path: 'work/auth',
    });

    expect(result).toContain('Auth Service');
    expect(result).toContain('Authentication and authorization module');
    expect(result).toContain('Implemented user login');
  });

  it('update_global then read round-trips global memory content', async () => {
    const globalContent = '# User Preferences\n\n- Prefers TypeScript\n- Uses Vitest for testing';

    await executeTool('memory', {
      action: 'update_global',
      content: globalContent,
    });

    const result = await executeTool('memory', { action: 'read' });

    expect(result).toContain('# User Preferences');
    expect(result).toContain('Prefers TypeScript');
    expect(result).toContain('Uses Vitest for testing');

    // Verify on-disk content matches
    const diskContent = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(diskContent).toBe(globalContent);
  });

  it('append to nested project creates all intermediate dirs', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Working on v2 API redesign',
      project_path: 'work/api/v2',
    });

    // Verify the nested directory structure was created
    const nestedDir = path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'v2');
    expect(fs.existsSync(nestedDir)).toBe(true);

    // Verify MEMORY.md exists in the deepest level
    const memFile = path.join(nestedDir, 'MEMORY.md');
    expect(fs.existsSync(memFile)).toBe(true);
    const content = fs.readFileSync(memFile, 'utf-8');
    expect(content).toContain('Working on v2 API redesign');

    // Read back via tool
    const readResult = await executeTool('memory', {
      action: 'read',
      project_path: 'work/api/v2',
    });
    expect(readResult).toContain('Working on v2 API redesign');
  });

  it('multiple appends accumulate in project memory', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'First entry: project setup',
      project_path: 'myproject',
    });

    await executeTool('memory', {
      action: 'append',
      content: 'Second entry: added tests',
      project_path: 'myproject',
    });

    const result = await executeTool('memory', {
      action: 'read',
      project_path: 'myproject',
    });

    expect(result).toContain('First entry: project setup');
    expect(result).toContain('Second entry: added tests');
  });

  it('append with target="daily" skips project memory on disk', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Daily-only observation',
      project_path: 'work/api',
      target: 'daily',
    });

    // Daily log should have the entry
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(true);
    const dailyContent = fs.readFileSync(dailyLogPath, 'utf-8');
    expect(dailyContent).toContain('Daily-only observation');

    // Project MEMORY.md should NOT exist
    const projectMemPath = path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'MEMORY.md');
    expect(fs.existsSync(projectMemPath)).toBe(false);
  });

  it('edit replaces content in project memory via tool', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Wrong fact: Earth is flat',
      project_path: 'work/api',
      target: 'project',
    });

    const editResult = await executeTool('memory', {
      action: 'edit',
      project_path: 'work/api',
      old_content: 'Wrong fact: Earth is flat',
      new_content: 'Correct fact: Earth is round',
    });

    // Verify result
    expect(editResult).toContain('updated');
    expect(editResult).toContain('Correct fact: Earth is round');

    // Verify file content
    const readResult = await executeTool('memory', {
      action: 'read',
      project_path: 'work/api',
    });
    expect(readResult).toContain('Correct fact: Earth is round');
    expect(readResult).not.toContain('Earth is flat');
  });

  it('edit with empty new_content deletes content', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Keep this',
      project_path: 'work/api',
      target: 'project',
    });

    await executeTool('memory', {
      action: 'append',
      content: 'Remove this junk',
      project_path: 'work/api',
      target: 'project',
    });

    const editResult = await executeTool('memory', {
      action: 'edit',
      project_path: 'work/api',
      old_content: 'Remove this junk',
      new_content: '',
    });

    expect(editResult).toContain('deleted');

    const readResult = await executeTool('memory', {
      action: 'read',
      project_path: 'work/api',
    });
    expect(readResult).toContain('Keep this');
    expect(readResult).not.toContain('Remove this junk');
  });

  it('edit returns error when old_content not found', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Some content',
      project_path: 'work/api',
      target: 'project',
    });

    const result = await executeTool('memory', {
      action: 'edit',
      project_path: 'work/api',
      old_content: 'nonexistent text',
      new_content: 'replacement',
    });

    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('edit returns error when project_path missing', async () => {
    const result = await executeTool('memory', {
      action: 'edit',
      old_content: 'some text',
      new_content: 'new text',
    });

    expect(result).toContain('Error');
    expect(result).toContain('project_path');
  });

  it('edit returns error when old_content missing', async () => {
    const result = await executeTool('memory', {
      action: 'edit',
      project_path: 'work/api',
      new_content: 'new text',
    });

    expect(result).toContain('Error');
    expect(result).toContain('old_content');
  });

  it('append with target="project" skips daily log on disk', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'Project-only knowledge',
      project_path: 'work/api',
      target: 'project',
    });

    // Project MEMORY.md should have the entry
    const projectMemPath = path.join(PROJECTS_MEMORY_DIR, 'work', 'api', 'MEMORY.md');
    expect(fs.existsSync(projectMemPath)).toBe(true);
    const projContent = fs.readFileSync(projectMemPath, 'utf-8');
    expect(projContent).toContain('Project-only knowledge');

    // Daily log should NOT exist
    const dateKey = formatDateKey();
    const dailyLogPath = path.join(DAILY_DIR, `${dateKey}.md`);
    expect(fs.existsSync(dailyLogPath)).toBe(false);
  });
});
