/**
 * The ✦ search's transcript shapes: built by the server, read back by the
 * browser. Every round-trip case here BUILDS with the real prompt builders
 * (task-search-agent-contract) and PARSES with the reader, so a reworded prompt
 * fails this file instead of silently un-carding a live transcript.
 *
 * The other invariant pinned here: ONE extractor finds the answer object for both
 * readers. The live pipeline turns it into the card's payload; the renderer keeps
 * the words around it and cards only the object (a live reply writes its reasoning
 * first, so "prose means render as prose" would leave the JSON on screen — the
 * 2026-09-17 report).
 */

import { describe, expect, it } from 'vitest';
import { buildSeedResultsBlock, buildUserPrompt, parseAgentAnswer } from '../../src/core/task-search-agent-contract.js';
import {
  AGENT_SEARCH_MAX_RESULTS,
  SEARCH_PROMPT_HEAD,
  cleanSearchText,
  extractResultsObject,
  parseSearchPromptMessage,
  splitSearchAnswerMessage,
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

describe('splitSearchAnswerMessage — words stay words, the object becomes rows', () => {
  const answer = (rows: unknown[], summary?: string) => JSON.stringify({ ...(summary ? { summary } : {}), results: rows });

  it('parses the exact shape a real answer has', () => {
    const split = splitSearchAnswerMessage(answer(
      [
        { task_id: 'mu4qx48p-4828', evidence: 'Unit test board search', confidence: 'high' },
        { task_id: 'mns4q7ld-af0e', evidence: '18/18 unit tests passing', confidence: 'medium' },
      ],
      'Two task-board searches match',
    ));
    expect(split?.before).toBe('');
    expect(split?.after).toBe('');
    expect(split?.answer.summary).toBe('Two task-board searches match');
    expect(split?.answer.rows.map((r) => r.taskId)).toEqual(['mu4qx48p-4828', 'mns4q7ld-af0e']);
    expect(split?.answer.rows[0].confidence).toBe('high');
    expect(split?.answer.extraRows).toBe(0);
  });

  // The shape a LIVE reply had (user report, 2026-09-17): reasoning first, a
  // numbered list of the tasks, then the object. The first version refused this
  // and left the JSON on screen under a card-less wall of text.
  it('keeps the model’s reasoning AND cards the object it ends with', () => {
    const prose = [
      'Looking at the seed results, I can see strong matches for "aihub cos":',
      '',
      '1. **Task mu4z2h5r-aa82** (session hit, updated today): "Hub answers now describe the current flow"',
      '2. **Task mt0m52lh-c252**: mentions the hub in context',
      '',
      'The other results mention "cos" but in different contexts.',
    ].join('\n');
    const split = splitSearchAnswerMessage(`${prose}\n\n${answer([
      { task_id: 'mu4z2h5r-aa82', evidence: 'Hub answers now describe the current flow', confidence: 'high' },
      { task_id: 'mt0m52lh-c252', evidence: 'mentions the hub in context', confidence: 'medium' },
    ])}`);
    expect(split).not.toBeNull();
    expect(split!.before).toBe(prose);
    expect(split!.after).toBe('');
    expect(split!.answer.rows.map((r) => r.taskId)).toEqual(['mu4z2h5r-aa82', 'mt0m52lh-c252']);
    // Not one character of the object is left in the prose half.
    expect(split!.before).not.toContain('task_id');
    expect(split!.before).not.toContain('"results"');
  });

  it('keeps words written AFTER the object too', () => {
    const split = splitSearchAnswerMessage(`${answer([{ task_id: 'mu4qx48p-4828' }])}\n\nHope that helps!`);
    expect(split?.before).toBe('');
    expect(split?.after).toBe('Hope that helps!');
    expect(split?.answer.rows).toHaveLength(1);
  });

  it('absorbs a ``` fence around the object, so no empty code block is left', () => {
    const split = splitSearchAnswerMessage(`Here it is:\n\n\`\`\`json\n${answer([{ task_id: 'mu4qx48p-4828' }])}\n\`\`\`\n\nDone.`);
    expect(split?.answer.rows).toHaveLength(1);
    expect(split?.before).toBe('Here it is:');
    expect(split?.after).toBe('Done.');
    expect(split?.before).not.toContain('```');
    expect(split?.after).not.toContain('```');
  });

  it('accepts a bare fenced object (models add one unasked)', () => {
    const split = splitSearchAnswerMessage(`\`\`\`json\n${answer([{ task_id: 'mu4qx48p-4828' }])}\n\`\`\``);
    expect(split?.answer.rows).toHaveLength(1);
    expect(split?.before).toBe('');
    expect(split?.after).toBe('');
  });

  it('renders a zero-result answer as a card, not as raw JSON', () => {
    const split = splitSearchAnswerMessage('{"results":[]}');
    expect(split).not.toBeNull();
    expect(split!.answer.rows).toEqual([]);
    expect(split!.answer.extraRows).toBe(0);
  });

  it(`caps the rendered rows at ${AGENT_SEARCH_MAX_RESULTS} and reports the rest`, () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ task_id: `mu4qx48p-00${i}` }));
    const split = splitSearchAnswerMessage(answer(rows));
    expect(split?.answer.rows).toHaveLength(AGENT_SEARCH_MAX_RESULTS);
    expect(split?.answer.extraRows).toBe(7 - AGENT_SEARCH_MAX_RESULTS);
  });

  it('collapses a task the model listed twice, keeping the first row’s evidence', () => {
    const split = splitSearchAnswerMessage(answer([
      { task_id: 'mu4qx48p-4828', evidence: 'the reason it matched' },
      { task_id: 'mns4q7ld-af0e' },
      { task_id: 'mu4qx48p-4828', evidence: 'listed again' },
    ]));
    expect(split?.answer.rows.map((r) => r.taskId)).toEqual(['mu4qx48p-4828', 'mns4q7ld-af0e']);
    expect(split?.answer.rows[0].evidence).toBe('the reason it matched');
    expect(split?.answer.extraRows).toBe(0);
  });

  it(`dedupes BEFORE the cap, so ${AGENT_SEARCH_MAX_RESULTS} distinct results all survive`, () => {
    const distinct = Array.from({ length: AGENT_SEARCH_MAX_RESULTS }, (_, i) => ({ task_id: `mu4qx48p-00${i}` }));
    const split = splitSearchAnswerMessage(answer([distinct[0], ...distinct, distinct[1]]));
    expect(split?.answer.rows.map((r) => r.taskId)).toEqual(distinct.map((r) => r.task_id));
    expect(split?.answer.extraRows).toBe(0);
  });

  it('flattens and clips the model’s free text (control chars, newlines, length)', () => {
    const split = splitSearchAnswerMessage(answer(
      [{ task_id: 'mu4qx48p-4828', evidence: `line one\nline\ttwo  ${'x'.repeat(400)}` }],
      `sum\nmary ${'y'.repeat(400)}`,
    ));
    const evidence = split!.answer.rows[0].evidence!;
    // Flattened: no newline, no tab, no control character, and no run of spaces
    // left behind. Single spaces are the POINT — the words stay readable.
    expect(evidence).not.toMatch(/[\n\t]/);
    expect(evidence).not.toMatch(/\p{C}/u);
    expect(evidence).not.toMatch(/ {2}/);
    expect(evidence).toContain('line one line two ');
    expect([...evidence].length).toBe(200);
    expect([...split!.answer.summary!].length).toBe(300);
  });

  it('drops a confidence value it does not know, keeping the row', () => {
    const split = splitSearchAnswerMessage(answer([{ task_id: 'mu4qx48p-4828', confidence: 'certain' }]));
    expect(split?.answer.rows[0].confidence).toBeUndefined();
  });

  it('takes the LAST object when the model printed a draft first', () => {
    const draft = answer([{ task_id: 'mu4qx48p-0000' }]);
    const final = answer([{ task_id: 'mns4q7ld-af0e' }]);
    const split = splitSearchAnswerMessage(`${draft}\n\nOn reflection:\n${final}`);
    expect(split?.answer.rows.map((r) => r.taskId)).toEqual(['mns4q7ld-af0e']);
    // The draft stays visible as the model's own text — nothing is hidden.
    expect(split?.before).toContain('mu4qx48p-0000');
  });

  describe('rejects — the message keeps rendering exactly as it does today', () => {
    it('the model’s narration between searches (no object at all)', () => {
      expect(splitSearchAnswerMessage('I need to search for more specific terms. Let me run targeted searches.')).toBeNull();
    });

    it('a row with no usable task_id — never silently drop a result', () => {
      expect(splitSearchAnswerMessage(answer([{ task_id: 'mu4qx48p-4828' }, { evidence: 'no id here' }]))).toBeNull();
      expect(splitSearchAnswerMessage(answer([{ task_id: '   ' }]))).toBeNull();
      expect(splitSearchAnswerMessage(answer([{ task_id: 42 }]))).toBeNull();
    });

    it('JSON that is not an answer', () => {
      expect(splitSearchAnswerMessage('{"tasks":[]}')).toBeNull();
      expect(splitSearchAnswerMessage('{"results":"none"}')).toBeNull();
      expect(splitSearchAnswerMessage('[{"task_id":"mu4qx48p-4828"}]')).toBeNull();
      expect(splitSearchAnswerMessage('{"results":[{"task_id":"a"}')).toBeNull();
    });

    it('a results list far longer than an answer can be', () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({ task_id: `mu4qx48p-0${i}` }));
      expect(splitSearchAnswerMessage(answer(rows))).toBeNull();
    });

    it('empty and whitespace input', () => {
      expect(splitSearchAnswerMessage('')).toBeNull();
      expect(splitSearchAnswerMessage('   \n ')).toBeNull();
    });
  });

  it('finds the same object the live pipeline finds (one extractor, two readers)', () => {
    const prosey = `Let me answer.\n${JSON.stringify({ results: [{ task_id: 'mu4qx48p-4828' }] })}`;
    expect(parseAgentAnswer(prosey).results).toHaveLength(1);
    expect(extractResultsObject(prosey)?.results).toHaveLength(1);
    // The renderer keeps the words and cards the object — nothing is dropped and
    // nothing is duplicated.
    const split = splitSearchAnswerMessage(prosey);
    expect(split?.before).toBe('Let me answer.');
    expect(split?.answer.rows).toHaveLength(1);
  });

  it('bounds the candidate walk on pathological input', () => {
    const started = Date.now();
    expect(splitSearchAnswerMessage(`${'{'.repeat(5_000)}}`)).toBeNull();
    expect(extractResultsObject(`${'{'.repeat(5_000)}}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('costs nothing on an ordinary coding reply full of braces', () => {
    // Every assistant message in every session is offered to this parser, so the
    // no-answer path must not walk brace candidates at all.
    const code = `Here is the fix:\n\n\`\`\`ts\n${'const x = { a: { b: 1 } };\n'.repeat(400)}\`\`\`\n`;
    const started = Date.now();
    for (let i = 0; i < 200; i++) expect(splitSearchAnswerMessage(code)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
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
