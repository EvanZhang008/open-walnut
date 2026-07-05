import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/memory-search.js', () => ({
  memoryNotesSearch: vi.fn(),
}));

import { buildSkillPrefetchHint } from '../../src/agent/skill-prefetch.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';

const mockSearch = vi.mocked(memoryNotesSearch);

beforeEach(() => {
  mockSearch.mockReset();
});

const result = (filepath: string) => ({
  filepath,
  title: '',
  snippet: '',
  score: 0.5,
  finalScore: 0.6,
  source: 'memory_skill',
  collection: 'skill',
});

describe('buildSkillPrefetchHint', () => {
  it('returns one hint line with skill names from SKILL.md paths', async () => {
    mockSearch.mockResolvedValue([
      result('/home/u/.open-walnut/skills/finance/tax-filing/SKILL.md'),
      result('/home/u/.open-walnut/skills/eks-oncall/SKILL.md'),
    ]);
    const hint = await buildSkillPrefetchHint('how do I file my taxes this year?');
    expect(hint).toBe(
      'Possibly relevant skills: tax-filing, eks-oncall — load with skill_view if applicable.',
    );
    // Searches ONLY the skill collection, with over-fetch (post-filter crowding)
    expect(mockSearch).toHaveBeenCalledWith(
      ['how do I file my taxes this year?'],
      ['memory_skill'],
      12,
    );
  });

  it('dedupes names and caps at 3', async () => {
    mockSearch.mockResolvedValue([
      result('/s/a/x/SKILL.md'),
      result('/s/a/x/SKILL.md'),
      result('/s/b/y/SKILL.md'),
      result('/s/c/z/SKILL.md'),
      result('/s/d/w/SKILL.md'),
    ]);
    const hint = await buildSkillPrefetchHint('a long enough user message');
    expect(hint).toContain('skills: x, y, z —');
  });

  it('returns null on empty results, trivial messages, and errors (silent)', async () => {
    mockSearch.mockResolvedValue([]);
    expect(await buildSkillPrefetchHint('a long enough user message')).toBeNull();

    expect(await buildSkillPrefetchHint('ok')).toBeNull();
    expect(await buildSkillPrefetchHint('')).toBeNull();

    mockSearch.mockRejectedValue(new Error('store not ready'));
    expect(await buildSkillPrefetchHint('a long enough user message')).toBeNull();
  });

  it('truncates very long messages to 500 chars for the query', async () => {
    mockSearch.mockResolvedValue([]);
    await buildSkillPrefetchHint('z'.repeat(2000));
    const [queries] = mockSearch.mock.calls[0];
    expect((queries as string[])[0]).toHaveLength(500);
  });
});
