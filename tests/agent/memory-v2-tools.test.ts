import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock the QMD search to avoid real model initialization
vi.mock('../../src/core/memory-search.js', () => ({
  memoryNotesSearch: vi.fn(),
}));

// Mock the files handler to avoid complex dependency chain
vi.mock('../../src/agent/tools/files/index.js', () => ({
  memoryHandler: {
    read: vi.fn(),
  },
  notesHandler: {
    read: vi.fn(),
  },
  resolveSource: vi.fn(() => {
    throw new Error('not a source URI');
  }),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { memoryNotesSearchTool } from '../../src/agent/tools/memory-notes-search-tool.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';
import { addTask, _resetForTesting } from '../../src/core/task-manager.js';

/**
 * Suite 9: Agent Tools (Unit)
 */

beforeEach(async () => {
  _resetForTesting();
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  vi.mocked(memoryNotesSearch).mockClear();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('memory_notes_search tool', () => {
  it('9.1: returns formatted results', async () => {
    vi.mocked(memoryNotesSearch).mockResolvedValue([
      {
        filepath: '/memory/daily/2026-04-12.md',
        title: 'Today',
        snippet: 'Worked on tests',
        score: 0.85,
        finalScore: 0.7654321,
        source: 'daily',
        collection: 'daily',
      },
      {
        filepath: '/memory/topics/walnut.md',
        title: 'Walnut',
        snippet: 'TypeScript React frontend',
        score: 0.9,
        finalScore: 0.9123456,
        source: 'topic',
        collection: 'topic',
      },
    ]);

    const result = await memoryNotesSearchTool.execute({
      queries: ['test'],
      limit: 5,
    });
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveLength(2);
    // Each result has expected fields
    for (const r of parsed) {
      expect(r).toHaveProperty('source');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('snippet');
      expect(r).toHaveProperty('filepath');
      expect(r).toHaveProperty('score');
    }
    // Score should be rounded to 3 decimal places
    expect(parsed[0].score).toBe(0.765);
    expect(parsed[1].score).toBe(0.912);
  });

  it('9.2: returns "No results found." for empty results', async () => {
    vi.mocked(memoryNotesSearch).mockResolvedValue([]);
    const result = await memoryNotesSearchTool.execute({
      queries: ['nonexistent'],
    });
    expect(result).toBe('No results found.');
  });

  it('9.3: passes queries/sources/limit/path parameters correctly', async () => {
    vi.mocked(memoryNotesSearch).mockResolvedValue([]);
    await memoryNotesSearchTool.execute({
      queries: ['test'],
      sources: ['memory_daily', 'note_vault'],
      path: 'walnut/overview/history/',
    });
    // 5th arg pins rerank:false — QMD's reranker is a native llama.cpp call that
    // blocks the event loop, and the agent loop runs inside the web server process,
    // so leaving it on froze the whole app for ~3s per tool call (28.7s call).
    expect(memoryNotesSearch).toHaveBeenCalledWith(
      ['test'],
      ['memory_daily', 'note_vault'],
      15,
      'walnut/overview/history/',
      { rerank: false },
    );
  });

  it('9.4: resolves an exact task ID without invoking QMD', async () => {
    const { task } = await addTask({
      title: 'Structured agent memory result',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });

    const result = await memoryNotesSearchTool.execute({
      queries: [task.id],
      sources: ['task'],
    });

    expect(memoryNotesSearch).not.toHaveBeenCalled();
    expect(JSON.parse(result as string)).toEqual([
      expect.objectContaining({
        source: 'task',
        taskId: task.id,
        title: task.title,
      }),
    ]);
  });
});
