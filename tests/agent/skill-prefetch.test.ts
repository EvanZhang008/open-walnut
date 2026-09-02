import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ searchV2Lane: vi.fn() }));

vi.mock('../../src/core/search/wiring.js', () => ({
  searchV2Lane: mocks.searchV2Lane,
  isSearchV2Enabled: () => true,
}));

import { buildSkillPrefetchHint } from '../../src/agent/skill-prefetch.js';

const mockSearch = mocks.searchV2Lane;

beforeEach(() => {
  mockSearch.mockReset();
});

/** One skill-kind index hit; `ref` is the absolute file path. */
const result = (ref: string) => ({
  kind: 'skill',
  ref,
  title: '',
  text: '',
  score: 0.6,
  components: { coverage: 1, cosine: 0 },
  semantic: 'off',
});

describe('buildSkillPrefetchHint', () => {
  it('returns one hint line with skill names from SKILL.md paths', async () => {
    mockSearch.mockResolvedValue([
      result('/home/u/.open-walnut/skills/finance/tax-filing/SKILL.md'),
      result('/home/u/.open-walnut/skills/team-oncall/SKILL.md'),
    ]);
    const hint = await buildSkillPrefetchHint('how do I file my taxes this year?');
    expect(hint).toBe(
      'Possibly relevant skills: tax-filing, team-oncall — load with skill_view if applicable.',
    );
    // Searches ONLY the skill kind, with over-fetch (post-filter crowding), and
    // with the semantic rescore deadline at 0: this runs on every agent turn,
    // inside the web server's event loop, purely to produce one advisory hint
    // line. Waiting on an embedding there cost seconds of first-token latency.
    expect(mockSearch).toHaveBeenCalledWith(
      'how do I file my taxes this year?',
      { kinds: ['skill'], limit: 12, semanticDeadlineMs: 0 },
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

  it('ignores support-file hits (references/, overview history) — SKILL.md only', async () => {
    // The skill kind indexes every .md under skills/, support files included.
    // Their dirname would produce junk names ("references", "history").
    mockSearch.mockResolvedValue([
      result('/s/walnut/overview/history/log.md'),
      result('/s/finance/tax-filing/references/deadlines.md'),
      result('/s/finance/tax-filing/SKILL.md'),
    ]);
    const hint = await buildSkillPrefetchHint('a long enough user message');
    expect(hint).toBe(
      'Possibly relevant skills: tax-filing — load with skill_view if applicable.',
    );
  });

  it('returns null when ALL hits are support files', async () => {
    mockSearch.mockResolvedValue([
      result('/s/walnut/overview/history/log.md'),
      result('/s/walnut/overview/history/log.20260701-1.md'),
    ]);
    expect(await buildSkillPrefetchHint('a long enough user message')).toBeNull();
  });

  it('returns null on empty results, trivial messages, and errors (silent)', async () => {
    mockSearch.mockResolvedValue([]);
    expect(await buildSkillPrefetchHint('a long enough user message')).toBeNull();

    expect(await buildSkillPrefetchHint('ok')).toBeNull();
    expect(await buildSkillPrefetchHint('')).toBeNull();

    mockSearch.mockRejectedValue(new Error('index not ready'));
    expect(await buildSkillPrefetchHint('a long enough user message')).toBeNull();
  });

  it('truncates very long messages to 500 chars for the query', async () => {
    mockSearch.mockResolvedValue([]);
    await buildSkillPrefetchHint('z'.repeat(2000));
    const [query] = mockSearch.mock.calls[0];
    expect(query as string).toHaveLength(500);
  });
});
