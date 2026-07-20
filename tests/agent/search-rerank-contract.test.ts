import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  memoryNotesSearch: vi.fn(),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('search-rerank-contract-test'));

vi.mock('../../src/core/memory-search.js', () => ({
  memoryNotesSearch: mocks.memoryNotesSearch,
}));

import { tools } from '../../src/agent/tools.js';

const taskSearchTool = tools.find(tool => tool.name === 'task_search')!;
const memoryNotesSearchTool = tools.find(tool => tool.name === 'memory_notes_search')!;

beforeEach(() => {
  mocks.memoryNotesSearch.mockReset().mockResolvedValue([]);
});

describe('agent search rerank contract', () => {
  it('task_search preserves the core default reranker', async () => {
    const queries = ['find the deployment task', 'deployment task'];

    await taskSearchTool.execute({ queries, limit: 7 });

    expect(mocks.memoryNotesSearch).toHaveBeenCalledOnce();
    expect(mocks.memoryNotesSearch.mock.calls[0]).toEqual([
      queries,
      ['task'],
      7,
    ]);
  });

  it('memory_notes_search preserves the core default reranker', async () => {
    const queries = ['when did we deploy', 'deployment history'];

    await memoryNotesSearchTool.execute({
      queries,
      sources: ['memory_daily'],
      limit: 6,
      path: '2026-07',
    });

    expect(mocks.memoryNotesSearch).toHaveBeenCalledOnce();
    expect(mocks.memoryNotesSearch.mock.calls[0]).toEqual([
      queries,
      ['memory_daily'],
      6,
      '2026-07',
    ]);
  });
});
