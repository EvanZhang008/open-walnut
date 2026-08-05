/**
 * Tests for journal_recent context source — loads recent diary entries
 * from NOTES_DIR/journal/Dairy/YYYY-MM-DD.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { loadContextSources } from '../../src/agent/context-sources.js';
import { WALNUT_HOME, NOTES_DIR } from '../../src/constants.js';
import type { AgentDefinition } from '../../src/core/types.js';

// ── Helpers ──

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    runner: 'embedded',
    source: 'config',
    ...overrides,
  };
}

function diaryDir(): string {
  // Vault went topic-first 2026-08 (PARA retired): journal/ is top-level now.
  return path.join(NOTES_DIR, 'journal', 'Dairy');
}

async function writeDiaryFile(dateStr: string, content: string): Promise<void> {
  const dir = diaryDir();
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${dateStr}.md`), content, 'utf-8');
}

// ── Setup / teardown ──

beforeEach(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('journal_recent context source', () => {
  it('loads diary entries wrapped in <recent_journal> tag', async () => {
    await writeDiaryFile('2026-04-10', 'Had a great day working on the project.');
    await writeDiaryFile('2026-04-09', 'Started the new feature design.');

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).toContain('<recent_journal>');
    expect(result).toContain('</recent_journal>');
    expect(result).toContain('Had a great day working on the project.');
    expect(result).toContain('Started the new feature design.');
    // Entries should be date-headed
    expect(result).toContain('--- 2026-04-10 ---');
    expect(result).toContain('--- 2026-04-09 ---');
  });

  it('returns most recent 7 entries sorted newest first', async () => {
    // Write 9 files — only the latest 7 should appear
    for (let day = 1; day <= 9; day++) {
      const dateStr = `2026-04-${String(day).padStart(2, '0')}`;
      await writeDiaryFile(dateStr, `Entry for day ${day}`);
    }

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    // Newest 7: days 3–9
    expect(result).toContain('Entry for day 9');
    expect(result).toContain('Entry for day 3');
    // Days 1–2 should be excluded (oldest, beyond 7-entry limit)
    expect(result).not.toContain('Entry for day 1\n');
    expect(result).not.toContain('Entry for day 2\n');
  });

  it('filters only YYYY-MM-DD.md files and ignores others', async () => {
    const dir = diaryDir();
    await fsp.mkdir(dir, { recursive: true });

    // Valid diary file
    await writeDiaryFile('2026-04-10', 'Valid diary entry');

    // Non-matching files that should be ignored
    await fsp.writeFile(path.join(dir, 'notes.md'), 'Random notes', 'utf-8');
    await fsp.writeFile(path.join(dir, 'README.md'), 'Read me', 'utf-8');
    await fsp.writeFile(path.join(dir, '2026-4-10.md'), 'Bad date format', 'utf-8');
    await fsp.writeFile(path.join(dir, 'template.txt'), 'Text file', 'utf-8');
    await fsp.writeFile(path.join(dir, '2026-04-10.txt'), 'Wrong extension', 'utf-8');
    await fsp.writeFile(path.join(dir, '26-04-10.md'), 'Short year', 'utf-8');

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).toContain('Valid diary entry');
    expect(result).not.toContain('Random notes');
    expect(result).not.toContain('Read me');
    expect(result).not.toContain('Bad date format');
    expect(result).not.toContain('Text file');
    expect(result).not.toContain('Wrong extension');
    expect(result).not.toContain('Short year');
  });

  it('returns fallback when diary directory does not exist', async () => {
    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).toContain('<recent_journal>');
    expect(result).toContain('(no diary entries found)');
    expect(result).toContain('</recent_journal>');
  });

  it('returns fallback when diary directory is empty', async () => {
    await fsp.mkdir(diaryDir(), { recursive: true });

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).toContain('<recent_journal>');
    expect(result).toContain('(no diary entries found)');
    expect(result).toContain('</recent_journal>');
  });

  it('returns fallback when directory has only non-matching files', async () => {
    const dir = diaryDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes.md'), 'Not a diary', 'utf-8');

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: true }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).toContain('(no diary entries found)');
  });

  it('does not load when journal_recent is disabled', async () => {
    await writeDiaryFile('2026-04-10', 'Should not appear');

    const agent = makeAgentDef({
      context_sources: [{ id: 'journal_recent', enabled: false }],
    });

    const result = await loadContextSources(agent, {});

    expect(result).not.toContain('<recent_journal>');
    expect(result).not.toContain('Should not appear');
  });
});
