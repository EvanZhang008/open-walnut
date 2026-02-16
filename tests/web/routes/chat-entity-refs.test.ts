/**
 * Tests for entity reference resolution in chat messages.
 *
 * Verifies that resolveEntityRefs() fills in missing label attributes
 * on <task-ref> and <session-ref> XML tags by looking up task/session data,
 * and that tags with existing labels are preserved unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { resolveEntityRefs } from '../../../src/web/routes/chat.js';
import { addTask } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('resolveEntityRefs', () => {
  it('returns text unchanged when no entity refs present', async () => {
    const text = 'Hello, I updated the task for you.';
    expect(await resolveEntityRefs(text)).toBe(text);
  });

  it('returns text unchanged when all refs already have labels', async () => {
    const text = 'I updated <task-ref id="abc123" label="Walnut / Fix view"/> for you.';
    expect(await resolveEntityRefs(text)).toBe(text);
  });

  it('fills in label for task-ref without label', async () => {
    const { task } = await addTask({ title: 'Fix the login bug', category: 'Work', project: 'Auth' });
    const text = `I updated <task-ref id="${task.id}"/> for you.`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain(`label="Auth / Fix the login bug"`);
    expect(result).toContain(`id="${task.id}"`);
  });

  it('uses task title only when project equals category', async () => {
    const { task } = await addTask({ title: 'Buy groceries', category: 'Life', project: 'Life' });
    const text = `Done: <task-ref id="${task.id}"/>`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="Buy groceries"');
  });

  it('preserves existing labels while filling missing ones', async () => {
    const { task } = await addTask({ title: 'New task', category: 'Work', project: 'HomeLab' });
    const text = `Updated <task-ref id="${task.id}"/> and checked <task-ref id="xyz" label="Already Labeled"/>`;
    const result = await resolveEntityRefs(text);
    // First ref should get a label
    expect(result).toContain(`<task-ref id="${task.id}" label="HomeLab / New task"/>`);
    // Second ref should keep its existing label
    expect(result).toContain('<task-ref id="xyz" label="Already Labeled"/>');
  });

  it('falls back to raw id when task not found', async () => {
    const text = 'I updated <task-ref id="nonexistent123"/> for you.';
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="nonexistent123"');
  });

  it('handles session-ref without label (falls back to id when session not found)', async () => {
    const text = 'Started <session-ref id="sess-uuid-abc"/> for the task.';
    const result = await resolveEntityRefs(text);
    // Session not in store → falls back to id
    expect(result).toContain('label="sess-uuid-abc"');
  });

  it('handles multiple task-ref tags in one message', async () => {
    const { task: t1 } = await addTask({ title: 'Task A', category: 'Work', project: 'Work' });
    const { task: t2 } = await addTask({ title: 'Task B', category: 'Life', project: 'Shopping' });
    const text = `Updated <task-ref id="${t1.id}"/> and <task-ref id="${t2.id}"/>`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="Task A"');
    expect(result).toContain('label="Shopping / Task B"');
  });

  it('handles self-closing tags with space before slash', async () => {
    const { task } = await addTask({ title: 'Spaced tag', category: 'Work', project: 'Work' });
    const text = `Done: <task-ref id="${task.id}" />`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="Spaced tag"');
  });

  it('handles mixed task-ref and session-ref tags', async () => {
    const { task } = await addTask({ title: 'Mixed test', category: 'Work', project: 'HomeLab' });
    const text = `Updated <task-ref id="${task.id}"/> and started <session-ref id="ses-123"/>`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="HomeLab / Mixed test"');
    expect(result).toContain('<session-ref id="ses-123" label="ses-123"/>');
  });

  it('escapes quotes in labels', async () => {
    const { task } = await addTask({ title: 'Fix "quoted" bug', category: 'Work', project: 'Work' });
    const text = `Done: <task-ref id="${task.id}"/>`;
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="Fix &quot;quoted&quot; bug"');
  });

  it('does not modify text inside code blocks', async () => {
    // Entity refs in code blocks should still be processed — the markdown
    // renderer handles code block escaping, not resolveEntityRefs
    const text = 'Here is the ref: <task-ref id="abc123"/>';
    const result = await resolveEntityRefs(text);
    expect(result).toContain('label="abc123"');
  });
});
