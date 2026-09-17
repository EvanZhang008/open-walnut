/**
 * The ✦ search's transcript shapes: built by the server, read back by the
 * browser. Every round-trip case here BUILDS with the real prompt builders
 * (task-search-agent-contract) and PARSES with the reader, so a reworded prompt
 * fails this file instead of silently un-carding a live transcript.
 *
 * The strictness split is the other invariant pinned here: the live pipeline's
 * `extractResultsObject` stays tolerant (a best-effort answer beats a 502) while
 * the renderer's `parseSearchAnswerMessage` refuses anything but the bare object,
 * because prose in a message must render as prose.
 */

import { describe, expect, it } from 'vitest';
import { buildSeedResultsBlock, buildUserPrompt, parseAgentAnswer } from '../../src/core/task-search-agent-contract.js';
import {
  AGENT_SEARCH_MAX_RESULTS,
  SEARCH_PROMPT_HEAD,
  cleanSearchText,
  extractResultsObject,
  parseSearchAnswerMessage,
  parseSearchPromptMessage,
} from '../../src/core/task-search-transcript.js';

const ROWS = JSON.stringify([
  { type: 'task', title: 'Unit test board search', snippet: 'Unit test board search', taskId: 'mu4qx48p-4828', phase: 'COMPLETE', updated: '2026-09-16', score: 0.87 },
  { type: 'session', title: 'Assess disk-read follow-up', snippet: 'add unit test for plan content…', taskId: 'mm7a4bc7-9680', phase: 'COMPLETE', updated: '2026-08-08', score: 0.82 },
]);

function promptWithSeed(query: string): string {
  return buildUserPrompt(query) + buildSeedResultsBlock(ROWS);
}

describe('parseSearchPromptMessage — round trip with the real builders', () => {
  it('splits the query out of a seeded prompt and counts the seed rows', () => {
    const parsed = parseSearchPromptMessage(promptWithSeed('unit test'));
    expect(parsed).not.toBeNull();
    expect(parsed!.query).toBe('unit test');
    expect(parsed!.seedRows).toBe(2);
    // The seed block stays verbatim — the disclosure discloses, it does not edit.
    expect(parsed!.seed).toContain(ROWS);
    expect(parsed!.seed).toContain('answer now with ALL of them');
    // …and nothing of the dump leaks into the query.
    expect(parsed!.query).not.toContain('SEED RESULTS');
  });

  it('parses a prompt with no seed block (the seed fetch is allowed to fail)', () => {
    const parsed = parseSearchPromptMessage(buildUserPrompt('deploy rollback plan'));
    expect(parsed?.query).toBe('deploy rollback plan');
    expect(parsed?.seed).toBeUndefined();
    expect(parsed?.seedRows).toBeUndefined();
  });

  it('keeps a query that contains triple quotes, because the seed sentinel ends it', () => {
    const query = 'why does """quoted""" break';
    const parsed = parseSearchPromptMessage(promptWithSeed(query));
    expect(parsed?.query).toBe(query);
    expect(parsed?.seedRows).toBe(2);
  });

  it('carries Unicode through by code point (emoji, CJK, combining marks)', () => {
    const query = '\u{1F600} 测试 café ἞6';
    expect(parseSearchPromptMessage(promptWithSeed(query))?.query).toBe(query);
  });

  it('parses a 400-char query (the route’s own ceiling)', () => {
    const query = 'a'.repeat(400);
    expect(parseSearchPromptMessage(promptWithSeed(query))?.query).toBe(query);
  });

  it('parses a transcript exported with CRLF line endings', () => {
    const crlf = promptWithSeed('unit test').replace(/\n/g, '\r\n');
    const parsed = parseSearchPromptMessage(crlf);
    expect(parsed?.query).toBe('unit test');
    expect(parsed?.raw.includes('\r')).toBe(false);
  });

  it('tolerates leading whitespace before the head line', () => {
    expect(parseSearchPromptMessage(`\n  \n${promptWithSeed('unit test')}`)?.query).toBe('unit test');
  });

  it('is stable across repeated parses (no shared regex lastIndex)', () => {
    const text = promptWithSeed('unit test');
    expect(parseSearchPromptMessage(text)).toEqual(parseSearchPromptMessage(text));
  });

  describe('refuses anything it does not fully understand', () => {
    it('a message that merely QUOTES the head line mid-prose', () => {
      expect(parseSearchPromptMessage(`I keep seeing "${SEARCH_PROMPT_HEAD}" in my transcripts\n"""why"""`)).toBeNull();
    });

    it('extra text between the quoted query and the seed block', () => {
      const text = `${buildUserPrompt('unit test')}\nAlso check my notes.${buildSeedResultsBlock(ROWS)}`;
      expect(parseSearchPromptMessage(text)).toBeNull();
    });

    it('an unclosed quote fence', () => {
      expect(parseSearchPromptMessage(`${SEARCH_PROMPT_HEAD}\n"""unit test`)).toBeNull();
    });

    it('an empty or whitespace-only query', () => {
      expect(parseSearchPromptMessage(buildUserPrompt(''))).toBeNull();
      expect(parseSearchPromptMessage(buildUserPrompt('   '))).toBeNull();
    });

    it('ordinary user text and the empty message', () => {
      expect(parseSearchPromptMessage('can you fix the build?')).toBeNull();
      expect(parseSearchPromptMessage('')).toBeNull();
    });

    it('a seed block whose row line is not JSON — the block still parses, the count does not', () => {
      const text = `${buildUserPrompt('unit test')}${buildSeedResultsBlock('[not json')}`;
      const parsed = parseSearchPromptMessage(text);
      expect(parsed?.query).toBe('unit test');
      expect(parsed?.seedRows).toBeUndefined();
      expect(parsed?.seed).toContain('[not json');
    });
  });
});

describe('parseSearchAnswerMessage — strict, for rendering', () => {
  const answer = (rows: unknown[], summary?: string) => JSON.stringify({ ...(summary ? { summary } : {}), results: rows });

  it('parses the exact shape a real answer has', () => {
    const parsed = parseSearchAnswerMessage(answer(
      [
        { task_id: 'mu4qx48p-4828', evidence: 'Unit test board search', confidence: 'high' },
        { task_id: 'mns4q7ld-af0e', evidence: '18/18 unit tests passing', confidence: 'medium' },
      ],
      'Two task-board searches match',
    ));
    expect(parsed?.summary).toBe('Two task-board searches match');
    expect(parsed?.rows.map((r) => r.taskId)).toEqual(['mu4qx48p-4828', 'mns4q7ld-af0e']);
    expect(parsed?.rows[0].confidence).toBe('high');
    expect(parsed?.extraRows).toBe(0);
  });

  it('accepts the same object inside a ``` fence (models add one unasked)', () => {
    const parsed = parseSearchAnswerMessage(`\`\`\`json\n${answer([{ task_id: 'mu4qx48p-4828' }])}\n\`\`\``);
    expect(parsed?.rows).toHaveLength(1);
  });

  it('renders a zero-result answer as a card, not as raw JSON', () => {
    const parsed = parseSearchAnswerMessage('{"results":[]}');
    expect(parsed).not.toBeNull();
    expect(parsed!.rows).toEqual([]);
    expect(parsed!.extraRows).toBe(0);
  });

  it(`caps the rendered rows at ${AGENT_SEARCH_MAX_RESULTS} and reports the rest`, () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ task_id: `mu4qx48p-00${i}` }));
    const parsed = parseSearchAnswerMessage(answer(rows));
    expect(parsed?.rows).toHaveLength(AGENT_SEARCH_MAX_RESULTS);
    expect(parsed?.extraRows).toBe(7 - AGENT_SEARCH_MAX_RESULTS);
  });

  it('collapses a task the model listed twice, keeping the first row’s evidence', () => {
    const parsed = parseSearchAnswerMessage(answer([
      { task_id: 'mu4qx48p-4828', evidence: 'the reason it matched' },
      { task_id: 'mns4q7ld-af0e' },
      { task_id: 'mu4qx48p-4828', evidence: 'listed again' },
    ]));
    expect(parsed?.rows.map((r) => r.taskId)).toEqual(['mu4qx48p-4828', 'mns4q7ld-af0e']);
    expect(parsed?.rows[0].evidence).toBe('the reason it matched');
    expect(parsed?.extraRows).toBe(0);
  });

  it(`dedupes BEFORE the cap, so ${AGENT_SEARCH_MAX_RESULTS} distinct results all survive`, () => {
    const distinct = Array.from({ length: AGENT_SEARCH_MAX_RESULTS }, (_, i) => ({ task_id: `mu4qx48p-00${i}` }));
    const parsed = parseSearchAnswerMessage(answer([distinct[0], ...distinct, distinct[1]]));
    expect(parsed?.rows.map((r) => r.taskId)).toEqual(distinct.map((r) => r.task_id));
    expect(parsed?.extraRows).toBe(0);
  });

  it('flattens and clips the model’s free text (control chars, newlines, length)', () => {
    const parsed = parseSearchAnswerMessage(answer(
      [{ task_id: 'mu4qx48p-4828', evidence: `line one\nline\ttwo  ${'x'.repeat(400)}` }],
      `sum\nmary ${'y'.repeat(400)}`,
    ));
    expect(parsed!.rows[0].evidence).not.toMatch(/[\n\t ]/);
    expect([...parsed!.rows[0].evidence!].length).toBe(200);
    expect([...parsed!.summary!].length).toBe(300);
  });

  it('drops a confidence value it does not know, keeping the row', () => {
    const parsed = parseSearchAnswerMessage(answer([{ task_id: 'mu4qx48p-4828', confidence: 'certain' }]));
    expect(parsed?.rows[0].confidence).toBeUndefined();
  });

  describe('rejects — the message keeps rendering as text', () => {
    it('the model’s narration between searches', () => {
      expect(parseSearchAnswerMessage('I need to search for more specific terms. Let me run targeted searches.')).toBeNull();
    });

    it('prose wrapped around the object', () => {
      expect(parseSearchAnswerMessage(`Here is the answer:\n${answer([{ task_id: 'mu4qx48p-4828' }])}`)).toBeNull();
      expect(parseSearchAnswerMessage(`${answer([{ task_id: 'mu4qx48p-4828' }])}\nHope that helps!`)).toBeNull();
    });

    it('a row with no usable task_id — never silently drop a result', () => {
      expect(parseSearchAnswerMessage(answer([{ task_id: 'mu4qx48p-4828' }, { evidence: 'no id here' }]))).toBeNull();
      expect(parseSearchAnswerMessage(answer([{ task_id: '   ' }]))).toBeNull();
      expect(parseSearchAnswerMessage(answer([{ task_id: 42 }]))).toBeNull();
    });

    it('JSON that is not an answer', () => {
      expect(parseSearchAnswerMessage('{"tasks":[]}')).toBeNull();
      expect(parseSearchAnswerMessage('{"results":"none"}')).toBeNull();
      expect(parseSearchAnswerMessage('[{"task_id":"mu4qx48p-4828"}]')).toBeNull();
      expect(parseSearchAnswerMessage('{"results":[{"task_id":"a"}')).toBeNull();
    });

    it('a results list far longer than an answer can be', () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({ task_id: `mu4qx48p-0${i}` }));
      expect(parseSearchAnswerMessage(answer(rows))).toBeNull();
    });

    it('empty and whitespace input', () => {
      expect(parseSearchAnswerMessage('')).toBeNull();
      expect(parseSearchAnswerMessage('   \n ')).toBeNull();
    });
  });

  it('stays strict where the live pipeline stays tolerant (the one invariant)', () => {
    const prosey = `Let me answer.\n${JSON.stringify({ results: [{ task_id: 'mu4qx48p-4828' }] })}`;
    // Pipeline: an answer is better than a 502.
    expect(parseAgentAnswer(prosey).results).toHaveLength(1);
    expect(extractResultsObject(prosey)?.results).toHaveLength(1);
    // Renderer: there are words in this message, so it renders as words.
    expect(parseSearchAnswerMessage(prosey)).toBeNull();
  });

  it('bounds the candidate walk on pathological input', () => {
    const started = Date.now();
    expect(parseSearchAnswerMessage(`${'{'.repeat(5_000)}}`)).toBeNull();
    expect(extractResultsObject(`${'{'.repeat(5_000)}}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('cleanSearchText', () => {
  it('caps by code point so an emoji is never split mid-surrogate', () => {
    const cleaned = cleanSearchText('\u{1F600}'.repeat(10), 3);
    expect([...cleaned]).toHaveLength(3);
    expect(cleaned.includes('�')).toBe(false);
  });

  it('returns an empty string for non-strings', () => {
    expect(cleanSearchText(undefined, 10)).toBe('');
    expect(cleanSearchText(42, 10)).toBe('');
    expect(cleanSearchText({ a: 1 }, 10)).toBe('');
  });
});
