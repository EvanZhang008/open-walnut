/**
 * AskUserQuestion permission-card logic (web/src/components/sessions/ask-user-question.ts).
 *
 * The CLI's AskUserQuestion tool is a requiresUserInteraction tool: its permission
 * request reaches walnut in EVERY mode (including bypass), and the tool result
 * echoes the `answers` field back out of the permission response's `updatedInput`.
 * So the card's job is to turn UI selections into that `answers` map — an allow with
 * no answers is exactly the production bug this replaced (the model was told the
 * user answered, with nothing in it).
 *
 * Rendering lives in the React card; this file pins the parse + answer-building
 * decisions, which are the load-bearing part of the wire contract.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAskUserQuestionInput,
  buildAskUserAnswers,
  allAskUserQuestionsAnswered,
  toggleAskUserSelection,
  type AskQuestion,
} from '../../web/src/components/sessions/ask-user-question';

const DB_QUESTION = 'Which database should I use?';
const MIGRATE_QUESTION = 'Migrate the existing rows?';

const REAL_INPUT = {
  questions: [
    {
      question: DB_QUESTION,
      header: 'Database',
      options: [
        { label: 'Postgres', description: 'Managed, already in the stack' },
        { label: 'SQLite', description: 'Zero-ops, single file' },
      ],
    },
    {
      question: MIGRATE_QUESTION,
      options: [{ label: 'Yes' }, { label: 'No' }],
      multiSelect: true,
    },
  ],
};

describe('parseAskUserQuestionInput', () => {
  it('parses the real tool input shape (question, header, options, multiSelect)', () => {
    const parsed = parseAskUserQuestionInput(REAL_INPUT);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toEqual({
      question: DB_QUESTION,
      header: 'Database',
      options: [
        { label: 'Postgres', description: 'Managed, already in the stack' },
        { label: 'SQLite', description: 'Zero-ops, single file' },
      ],
      multiSelect: false,
    });
    expect(parsed![1].multiSelect).toBe(true);
    expect(parsed![1].header).toBeUndefined();
  });

  it('returns null for anything that is not a question set (generic card renders instead)', () => {
    expect(parseAskUserQuestionInput(undefined)).toBeNull();
    expect(parseAskUserQuestionInput({})).toBeNull();
    expect(parseAskUserQuestionInput({ questions: 'nope' })).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [] })).toBeNull();
    // A Bash-style input must never be mistaken for a question set.
    expect(parseAskUserQuestionInput({ command: 'ls -la' })).toBeNull();
  });

  it('drops malformed entries rather than rendering an unanswerable question', () => {
    // A blank question text has no usable `answers` key, and a non-object entry
    // has nothing to render — both are dropped, not crashed on.
    const parsed = parseAskUserQuestionInput({
      questions: [
        { question: '' },
        null,
        'not an object',
        { question: DB_QUESTION, options: [{ label: 'Postgres' }, { }, { label: '' }] },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed![0].question).toBe(DB_QUESTION);
    // Option entries with no label are dropped (a nameless pill can't be submitted).
    expect(parsed![0].options).toEqual([{ label: 'Postgres', description: undefined }]);
  });

  it('tolerates a question with no options at all (free-text only)', () => {
    const parsed = parseAskUserQuestionInput({ questions: [{ question: DB_QUESTION }] });
    expect(parsed![0].options).toEqual([]);
  });
});

describe('toggleAskUserSelection', () => {
  it('single-select replaces the pick, and re-clicking clears it', () => {
    expect(toggleAskUserSelection(undefined, 'Postgres', false)).toEqual(['Postgres']);
    expect(toggleAskUserSelection(['Postgres'], 'SQLite', false)).toEqual(['SQLite']);
    expect(toggleAskUserSelection(['Postgres'], 'Postgres', false)).toEqual([]);
  });

  it('multi-select toggles membership without dropping the others', () => {
    expect(toggleAskUserSelection(['Yes'], 'No', true)).toEqual(['Yes', 'No']);
    expect(toggleAskUserSelection(['Yes', 'No'], 'Yes', true)).toEqual(['No']);
  });
});

describe('buildAskUserAnswers', () => {
  const questions = parseAskUserQuestionInput(REAL_INPUT) as AskQuestion[];

  it('maps question TEXT to the chosen label — the key the CLI reads', () => {
    // The `answers` map is keyed by the question text, not by header or index:
    // the tool matches its own question strings when echoing answers back.
    const answers = buildAskUserAnswers(
      questions,
      { [DB_QUESTION]: ['Postgres'], [MIGRATE_QUESTION]: ['Yes'] },
      {},
    );
    expect(answers).toEqual({ [DB_QUESTION]: 'Postgres', [MIGRATE_QUESTION]: 'Yes' });
  });

  it('joins multi-select picks with a comma', () => {
    const answers = buildAskUserAnswers(questions, { [MIGRATE_QUESTION]: ['Yes', 'No'] }, {});
    expect(answers[MIGRATE_QUESTION]).toBe('Yes, No');
  });

  it('free text ("Other") overrides the option pills', () => {
    const answers = buildAskUserAnswers(
      questions,
      { [DB_QUESTION]: ['Postgres'] },
      { [DB_QUESTION]: '  DuckDB, actually  ' },
    );
    expect(answers[DB_QUESTION]).toBe('DuckDB, actually');
  });

  it('omits unanswered questions instead of sending empty strings', () => {
    // An empty-string answer would read to the model as a real (blank) answer —
    // the same lie as the auto-allow bug. Omit it so only real answers ship.
    const answers = buildAskUserAnswers(questions, { [DB_QUESTION]: ['SQLite'] }, { [MIGRATE_QUESTION]: '   ' });
    expect(answers).toEqual({ [DB_QUESTION]: 'SQLite' });
    expect(Object.keys(answers)).not.toContain(MIGRATE_QUESTION);
  });

  it('produces string values only — the server rejects anything else', () => {
    const answers = buildAskUserAnswers(questions, { [DB_QUESTION]: ['Postgres'] }, {});
    for (const v of Object.values(answers)) expect(typeof v).toBe('string');
  });
});

describe('allAskUserQuestionsAnswered (Submit gate)', () => {
  const questions = parseAskUserQuestionInput(REAL_INPUT) as AskQuestion[];

  it('stays false until EVERY question has an answer', () => {
    expect(allAskUserQuestionsAnswered(questions, {}, {})).toBe(false);
    expect(allAskUserQuestionsAnswered(questions, { [DB_QUESTION]: ['Postgres'] }, {})).toBe(false);
    expect(allAskUserQuestionsAnswered(
      questions,
      { [DB_QUESTION]: ['Postgres'], [MIGRATE_QUESTION]: ['No'] },
      {},
    )).toBe(true);
  });

  it('free text alone satisfies a question', () => {
    expect(allAskUserQuestionsAnswered(
      questions,
      {},
      { [DB_QUESTION]: 'DuckDB', [MIGRATE_QUESTION]: 'only the new rows' },
    )).toBe(true);
  });

  it('is false for an empty question list (nothing to submit)', () => {
    expect(allAskUserQuestionsAnswered([], {}, {})).toBe(false);
  });
});
