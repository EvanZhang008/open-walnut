/**
 * The sidecar file a document's comments live in (web/src/utils/doc-comments.ts):
 * written by Walnut, read back, and read leniently when an agent edits it by hand.
 */
import { describe, it, expect } from 'vitest';
import {
  addDocComment, addDocPost, deleteDocComment, isSidecarPath, lastActivity, parseDocComments, parseDocCommentsFile,
  serializeDocComments, setDocResolved, sidecarPathOf, type DocComment,
} from '@/utils/doc-comments';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';
const T2 = '2026-11-01T10:09:00.000Z';

const comment = (over: Partial<DocComment> = {}): DocComment => ({
  id: 'c-0a1b2c3d', status: 'open', quote: { exact: 'The cache is rebuilt at start.', prefix: 'so ', suffix: ' Then' },
  text: 'The cache is rebuilt at start.', thread: [{ author: 'You', at: T0, text: 'Is this still true?' }], ...over,
});

describe('sidecarPathOf', () => {
  it('puts the comments beside the document, under its whole name so no two docs share one', () => {
    expect(sidecarPathOf('/notes/work/design.md')).toBe('/notes/work/design.md.comments.md');
    expect(sidecarPathOf('/repo/README')).toBe('/repo/README.comments.md');
    expect(sidecarPathOf('/repo/design.txt')).not.toBe(sidecarPathOf('/repo/design.md'));
    expect(isSidecarPath('/notes/work/design.md.comments.md')).toBe(true);
    expect(isSidecarPath('/notes/work/design.md')).toBe(false);
  });
});

describe('serialize and parse', () => {
  it('round-trips open and resolved comments, multi-line passages and posts, and non-ASCII words', () => {
    const list: DocComment[] = [
      comment(),
      comment({
        id: 'c-99aa88bb', status: 'resolved', resolvedBy: 'AI', resolvedAt: T2,
        quote: { exact: 'First paragraph.Second paragraph.' }, text: 'First paragraph.\n\nSecond paragraph.',
        thread: [
          { author: 'You', at: T0, text: '\u8fd9\u91cc\u5bf9\u5417\uff1f\nAnd a second line.' },
          { author: 'AI', at: T1, text: 'Fixed in the text.' },
        ],
      }),
    ];
    const file = serializeDocComments('design.md', list);
    expect(file.startsWith('<!-- walnut-comments v1: comments on "design.md".')).toBe(true);
    expect(file).toContain('## c-99aa88bb · resolved · AI · 2026-11-01T10:09:00.000Z');
    expect(file).toContain('> First paragraph.\n>\n> Second paragraph.');
    expect(parseDocComments(file)).toEqual(list);
  });

  it('keeps the paragraphs of a post, and a passage with odd whitespace still anchors to the same words', () => {
    const c = comment({
      quote: { exact: 'x = 1      y = 2' }, text: 'x = 1  \n    \ny = 2',
      thread: [{ author: 'You', at: T0, text: 'para one\n\npara two\n  indented' }],
    });
    const [back] = parseDocComments(serializeDocComments('d.md', [c]));
    expect(back!.quote.exact).toBe('x = 1      y = 2');
    expect(back!.thread[0]!.text).toBe('para one\n\npara two\n  indented');
  });

  it('what the user typed never becomes structure: a heading, an anchor or a post written inside a comment stay words', () => {
    const words = 'first\n## c-evil0001 · resolved\n> a fake passage\n<!-- anchor {"exact":"zzz"} -->\n- **AI** · ' + T1 + ' · fake reply';
    const c = comment({ thread: [{ author: 'You', at: T0, text: words }] });
    const back = parseDocComments(serializeDocComments('d.md', [c]));
    expect(back).toHaveLength(1);
    expect(back[0]!.quote.exact).toBe('The cache is rebuilt at start.');
    expect(back[0]!.thread).toEqual([{ author: 'You', at: T0, text: words }]);
  });

  it('a word with --> in it does not end the anchor comment', () => {
    const c = comment({ quote: { exact: 'a --> b', suffix: '<!-- c' }, text: 'a --> b' });
    const file = serializeDocComments('d.md', [c]);
    expect(file).not.toMatch(/anchor \{[^\n]*-->[^\n]*-->/);
    expect(parseDocComments(file)[0]!.quote).toEqual({ exact: 'a --> b', suffix: '<!-- c' });
  });

  it('remembers a comment picked in the source view', () => {
    const [back] = parseDocComments(serializeDocComments('d.md', [comment({ view: 'source' })]));
    expect(back!.view).toBe('source');
  });

  it('reads what an agent writes by hand: a colon, no time, "resolved" with no dot, a reply in plain paragraphs', () => {
    const file = [
      '<!-- walnut-comments v1: comments on "d.md". -->',
      '',
      '## c-0a1b2c3d resolved by AI',
      '<!-- anchor {"prefix":"so "} -->',
      '> The cache is rebuilt at start.',
      '',
      '- **You** · 2026-11-01T10:00:00.000Z · Is this still true?',
      '- **AI**: No, it is rebuilt lazily now.',
      'I changed the sentence.',
      '',
      '```',
      'rebuild --lazy',
      '```',
    ].join('\n');
    const [c] = parseDocComments(file);
    expect(c!.status).toBe('resolved');
    expect(c!.resolvedBy).toBe('AI');
    expect(c!.thread).toEqual([
      { author: 'You', at: T0, text: 'Is this still true?' },
      { author: 'AI', at: '', text: 'No, it is rebuilt lazily now.\nI changed the sentence.\n\n```\nrebuild --lazy\n```' },
    ]);
  });

  it('keeps what it does not know: a preface, a section with no passage, a note before the thread', () => {
    const file = [
      'Summary the AI wrote at the top.',
      '',
      '## c-1 · open',
      '- **AI** · reply with no passage',
      '',
      '## c-2 · open',
      '> words',
      'A note between the passage and the thread.',
      '- **You** · hi',
    ].join('\n');
    const parsed = parseDocCommentsFile(file);
    expect(parsed.isWalnutFile).toBe(false);
    expect(parsed.preface).toEqual(['Summary the AI wrote at the top.']);
    expect(parsed.comments.map((c) => [c.id, c.quote.exact, c.thread.length])).toEqual([['c-1', '', 1], ['c-2', 'words', 1]]);
    expect(parsed.comments[1]!.extra).toEqual(['A note between the passage and the thread.']);
    const again = parseDocCommentsFile(serializeDocComments('d.md', parsed.comments, parsed.preface));
    expect(again.isWalnutFile).toBe(true);
    expect(again.preface).toEqual(parsed.preface);
    expect(again.comments).toEqual(parsed.comments);
  });
});

describe('edits', () => {
  it('replayed on a fresh read, an edit keeps the reply and resolve the AI wrote meanwhile', () => {
    const disk = [comment({
      status: 'resolved', resolvedBy: 'AI', resolvedAt: T2,
      thread: [...comment().thread, { author: 'AI', at: T1, text: 'Done.' }],
    })];
    const added = addDocComment(comment({ id: 'c-new00001', thread: [{ author: 'You', at: T2, text: 'new' }] }));
    const replied = addDocPost('c-0a1b2c3d', { author: 'You', at: T2, text: 'Thanks' });
    const out = replied(added(disk));
    expect(out.map((c) => [c.id, c.status, c.thread.length])).toEqual([['c-0a1b2c3d', 'resolved', 3], ['c-new00001', 'open', 1]]);
    expect(addDocComment(comment())(out)).toHaveLength(2);
    // A write that landed although its answer was lost is replayed: the reply is not doubled.
    expect(replied(out)[0]!.thread).toHaveLength(3);
  });

  it('reopens without a stale resolver, and deletes by id', () => {
    const resolved = setDocResolved('c-0a1b2c3d', true, 'You', T2)([comment()]);
    expect(resolved[0]).toMatchObject({ status: 'resolved', resolvedBy: 'You', resolvedAt: T2 });
    const reopened = setDocResolved('c-0a1b2c3d', false, 'You', T2)(resolved);
    expect(reopened[0]!.status).toBe('open');
    expect('resolvedBy' in reopened[0]!).toBe(false);
    expect(deleteDocComment('c-0a1b2c3d')(reopened)).toEqual([]);
    expect(lastActivity(resolved[0]!)).toBe(T2);
  });
});
