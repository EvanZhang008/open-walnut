import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock the index lane so no real search.sqlite / embed worker is opened.
const mocks = vi.hoisted(() => ({ searchV2Lane: vi.fn() }));
vi.mock('../../src/core/search/wiring.js', () => ({
  searchV2Lane: mocks.searchV2Lane,
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

import { GLOBAL_SKILLS_DIR, MEMORY_DIR, WALNUT_HOME } from '../../src/constants.js';
import { memoryNotesSearchTool } from '../../src/agent/tools/memory-notes-search-tool.js';
import { addTask, _resetForTesting } from '../../src/core/task-manager.js';

/**
 * Suite 9: Agent Tools (Unit)
 */

/** One index hit as searchV2Lane returns it. */
function hit(over: Record<string, unknown>) {
  return {
    kind: 'memory',
    ref: path.join(MEMORY_DIR, 'topics', 'placeholder.md'),
    title: 'Placeholder',
    text: '',
    score: 0.5,
    components: { coverage: 1, cosine: 0 },
    semantic: 'off',
    ...over,
  };
}

beforeEach(async () => {
  _resetForTesting();
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  mocks.searchV2Lane.mockReset();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('memory_notes_search tool', () => {
  it('9.1: returns formatted results', async () => {
    mocks.searchV2Lane.mockResolvedValue([
      hit({
        ref: path.join(MEMORY_DIR, 'daily', '2026-04-12.md'),
        title: 'Today',
        text: 'Worked on tests',
        score: 0.7654321,
      }),
      hit({
        ref: path.join(MEMORY_DIR, 'topics', 'walnut.md'),
        title: 'Walnut',
        text: 'TypeScript React frontend',
        score: 0.9123456,
      }),
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
    // Rows come back score-ordered, each rounded to 3 decimal places.
    expect(parsed[0].score).toBe(0.912);
    expect(parsed[1].score).toBe(0.765);
    // The QMD-era `source` contract survives: the bucket is recovered from the
    // file path, so callers still see memory_topic / memory_daily.
    expect(parsed[0].source).toBe('memory_topic');
    expect(parsed[1].source).toBe('memory_daily');
  });

  it('9.2: returns "No results found." for empty results', async () => {
    mocks.searchV2Lane.mockResolvedValue([]);
    const result = await memoryNotesSearchTool.execute({
      queries: ['nonexistent'],
    });
    expect(result).toBe('No results found.');
  });

  it('9.3: maps sources onto index kinds and over-fetches for the merge', async () => {
    mocks.searchV2Lane.mockResolvedValue([]);
    await memoryNotesSearchTool.execute({
      queries: ['test'],
      sources: ['memory_daily', 'note_vault'],
    });
    // Every memory_* bucket is one 'memory' kind; note_vault is 'note'. The
    // lane is over-fetched (2x limit) because sources/path filtering happens
    // after the hits come back.
    expect(mocks.searchV2Lane).toHaveBeenCalledWith('test', {
      kinds: ['memory', 'note'],
      limit: 30,
    });
  });

  it('9.3b: filters hits by the collection-relative path prefix', async () => {
    mocks.searchV2Lane.mockResolvedValue([
      hit({
        kind: 'skill',
        ref: path.join(GLOBAL_SKILLS_DIR, 'walnut', 'overview', 'history', '2026-08.md'),
        title: 'August history',
        text: 'shipped the search rewrite',
        score: 0.4,
      }),
      hit({
        kind: 'skill',
        ref: path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax.md'),
        title: 'Tax notes',
        text: 'unrelated',
        score: 0.9,
      }),
    ]);

    const result = await memoryNotesSearchTool.execute({
      queries: ['history'],
      sources: ['memory_skill'],
      path: 'walnut/overview/history/',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('August history');
  });

  it('9.4: resolves an exact task ID without touching the index lane', async () => {
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

    expect(mocks.searchV2Lane).not.toHaveBeenCalled();
    expect(JSON.parse(result as string)).toEqual([
      expect.objectContaining({
        source: 'task',
        taskId: task.id,
        title: task.title,
      }),
    ]);
  });
});
