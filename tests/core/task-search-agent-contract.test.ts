/**
 * Pure contract layer of the agent task search: tolerant JSON extraction,
 * id validation/enrichment against the real task table, ranking.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAgentAnswer,
  validateAndEnrich,
  rankAgentResults,
  normalizeQueryKey,
  buildCliSystemPrompt,
  buildSeedResultsBlock,
  AGENT_SEARCH_MAX_RESULTS,
  AGENT_SEARCH_PROMPT_V,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_TOOL_LOOP,
} from '../../src/core/task-search-agent-contract.js';
import type { Task } from '../../src/core/types.js';

function task(overrides: Partial<Task>): Task {
  return {
    id: 'mtaaaaaa-0000',
    title: 'A task',
    phase: 'TODO',
    status: 'active',
    project: '',
    updated_at: '2026-08-20T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

describe('parseAgentAnswer', () => {
  it('accepts a bare JSON object', () => {
    const raw = parseAgentAnswer('{"summary":"s","results":[{"task_id":"a"}]}');
    expect(raw.results).toHaveLength(1);
  });

  it('extracts from a fenced answer', () => {
    const raw = parseAgentAnswer('```json\n{"results":[{"task_id":"a"}]}\n```');
    expect(raw.results).toHaveLength(1);
  });

  it('survives prose that QUOTES tool-output JSON rows before the real answer (2026-08-30 502)', () => {
    const raw = parseAgentAnswer(
      'Looking at the seed results, there is a clear match:\n\n'
      + '- Result 6: `{"type":"task","title":"Docx file preview support","taskId":"mtchu05y-f1d0","score":0.84}`\n'
      + '- Result 7 also mentions docx.\n\n'
      + '{"summary":"Docx preview task found","results":[{"task_id":"mtchu05y-f1d0","evidence":"Docx file preview support","confidence":"high"}]}',
    );
    expect(raw.results).toHaveLength(1);
    expect(raw.results[0].task_id).toBe('mtchu05y-f1d0');
    expect(raw.summary).toBe('Docx preview task found');
  });

  it('extracts from prose-wrapped and trailing-text answers', () => {
    const raw = parseAgentAnswer('Here is what I found:\n{"results":[]}\nHope that helps!');
    expect(raw.results).toEqual([]);
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseAgentAnswer('no tasks found, sorry')).toThrow();
  });

  it('throws when results is not an array', () => {
    expect(() => parseAgentAnswer('{"results":"none"}')).toThrow();
  });

  it('drops non-object rows instead of crashing', () => {
    const raw = parseAgentAnswer('{"results":[null, "x", {"task_id":"a"}]}');
    expect(raw.results).toHaveLength(1);
  });
});

describe('validateAndEnrich', () => {
  const tasks = [
    task({ id: 'mt65k8x5-8c2d', title: 'Session: walnut', phase: 'NEED_ACTION', project: 'walnut', updated_at: '2026-08-23T10:00:00.000Z' }),
    task({ id: 'mtoldold-1111', title: 'Old viewer work', updated_at: '2025-01-01T00:00:00.000Z' }),
  ];

  it('drops invented ids and counts them', () => {
    const { results, droppedIds } = validateAndEnrich(
      { results: [{ task_id: 'not-a-real-id-xyz', evidence: 'e' }, { task_id: 'mt65k8x5-8c2d', evidence: 'e' }] },
      tasks,
    );
    expect(droppedIds).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe('mt65k8x5-8c2d');
  });

  it('resolves 8-char prefixes', () => {
    const { results } = validateAndEnrich({ results: [{ task_id: 'mt65k8x5', evidence: 'e' }] }, tasks);
    expect(results[0]?.taskId).toBe('mt65k8x5-8c2d');
  });

  it('collapses duplicates (task+session dedupe lands here)', () => {
    const { results } = validateAndEnrich(
      { results: [{ task_id: 'mt65k8x5-8c2d', evidence: 'a' }, { task_id: 'mt65k8x5', evidence: 'b' }] },
      tasks,
    );
    expect(results).toHaveLength(1);
  });

  it('always takes title/phase/project from the Task record, never the model', () => {
    const { results } = validateAndEnrich(
      { results: [{ task_id: 'mt65k8x5-8c2d', evidence: 'e', title: 'MODEL LIES' } as never] },
      tasks,
    );
    expect(results[0].title).toBe('Session: walnut');
    expect(results[0].phase).toBe('NEED_ACTION');
    expect(results[0].project).toBe('walnut');
    expect(results[0].updatedAt).toBe('2026-08-23T10:00:00.000Z');
  });

  it('cleans evidence: strips control chars, collapses whitespace, caps 200 code points', () => {
    const { results } = validateAndEnrich(
      { results: [{ task_id: 'mt65k8x5-8c2d', evidence: `a\u0000b\n\n  c${'x'.repeat(500)}` }] },
      tasks,
    );
    expect(results[0].evidence.startsWith('a b c')).toBe(true);
    expect([...results[0].evidence]).toHaveLength(200);
  });

  it('filters confidence to the known enum', () => {
    const { results } = validateAndEnrich(
      { results: [{ task_id: 'mt65k8x5-8c2d', evidence: 'e', confidence: 'certain' }] },
      tasks,
    );
    expect(results[0].confidence).toBeUndefined();
  });

  it('caps at AGENT_SEARCH_MAX_RESULTS', () => {
    const many = Array.from({ length: 10 }, (_, i) => task({ id: `mtcap${i}xx-000${i}`, title: `t${i}` }));
    const { results } = validateAndEnrich(
      { results: many.map((t) => ({ task_id: t.id, evidence: 'e' })) },
      many,
    );
    expect(results).toHaveLength(AGENT_SEARCH_MAX_RESULTS);
  });
});

describe('rankAgentResults', () => {
  it('keeps agent order across confidence buckets, recency-tiebreaks inside a bucket', () => {
    const ranked = rankAgentResults([
      { taskId: 'low', title: '', evidence: '', confidence: 'low', updatedAt: '2026-08-23T00:00:00Z' },
      { taskId: 'high-old', title: '', evidence: '', confidence: 'high', updatedAt: '2025-01-01T00:00:00Z' },
      { taskId: 'high-new', title: '', evidence: '', confidence: 'high', updatedAt: '2026-08-23T00:00:00Z' },
      { taskId: 'none', title: '', evidence: '' },
    ]);
    expect(ranked.map((r) => r.taskId)).toEqual(['high-new', 'high-old', 'low', 'none']);
  });
});

describe('normalizeQueryKey', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeQueryKey('  Docx   Preview \n Task ')).toBe('docx preview task');
  });
});

/**
 * v5 prompt contract (2026-09-05). Live failure: "side quesiton ask walnut"
 * had TWO genuine matches in the seed rows; "Usually ONE result" made the
 * model return only the task whose title shared the user's typo, and the
 * IN_PROGRESS task the user meant never showed. The prompt is now a
 * results-list contract with explicit typo + recency rules, and rows carry
 * phase/updated so recency is judgeable. Pin the load-bearing sentences.
 */
describe('prompt contract v5: a results list, not one pick', () => {
  it.each([
    ['cli (walnut CLI fallback)', SYSTEM_PROMPT],
    ['cli (local API)', buildCliSystemPrompt('http://127.0.0.1:1')],
    ['in-process tool loop', SYSTEM_PROMPT_TOOL_LOOP],
  ])('%s prompt asks for every plausible match and never "usually one"', (_name, prompt) => {
    expect(prompt).toContain('List EVERY distinct task that plausibly matches, best first, up to 5');
    expect(prompt).not.toContain('Usually ONE result');
    // Seed shortcut must not collapse the list back to one pick.
    expect(prompt).toContain('answer IMMEDIATELY with ALL of them');
    // A shared misspelling is not relevance; the numeric score is string similarity.
    expect(prompt).toContain('a row that repeats the user\'s exact typo is NOT more relevant');
    // Recency/phase is a ranking signal the rows actually carry.
    expect(prompt).toContain('Rows carry phase and updated (YYYY-MM-DD)');
    expect(prompt).toContain('the active one (not COMPLETE) and the recently-updated one ranks FIRST');
  });

  it('the local-API row note documents the phase/updated fields the slim route emits', () => {
    expect(buildCliSystemPrompt('http://127.0.0.1:1')).toContain('{type,id,title,summary,phase,updated}');
  });

  it('the seed block asks for ALL matches, and bumps the cache key past v4', () => {
    expect(buildSeedResultsBlock('[]')).toContain('answer now with ALL of them');
    expect(AGENT_SEARCH_PROMPT_V).not.toBe('v4');
  });
});
