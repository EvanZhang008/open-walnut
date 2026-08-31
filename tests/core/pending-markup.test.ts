/**
 * splitPendingMarkup — the rule that keeps a card from cutting a sentence in half.
 *
 * The incident (inc-1788209680147): a `commands_changed` system line landed while
 * the model was one character into an attribute. The flushed block ended with
 * `…padding:8`, the next began `px">全部降级为基线…`, so the reader got an empty
 * coloured pill followed by half an attribute as prose.
 *
 * Two properties matter more than any single case:
 *   · LOSSLESS — `safe + pending === input` always, so a carry cannot eat text.
 *   · CONSERVATIVE — prose that merely looks like a tag is never withheld, because
 *     withholding it would make ordinary text disappear for a beat (or forever, if
 *     the `>` never comes).
 */
import { describe, it, expect } from 'vitest';
import { splitPendingMarkup } from '../../src/core/stream/pending-markup.js';

/** safe+pending must reconstruct the input for EVERY case in this file. */
function split(text: string) {
  const r = splitPendingMarkup(text);
  expect(r.safe + r.pending, `lossless split of ${JSON.stringify(text)}`).toBe(text);
  return r;
}

describe('splitPendingMarkup', () => {
  describe('the reported case', () => {
    it('withholds an attribute that is still arriving', () => {
      const text = 'Skill 更新完，现在按新标准重排：\n\n<div style="border-left:3px solid #dc2626;padding:8';
      const { safe, pending } = split(text);
      expect(safe).toBe('Skill 更新完，现在按新标准重排：\n\n');
      expect(pending).toBe('<div style="border-left:3px solid #dc2626;padding:8');
    });

    it('releases it as soon as the tag closes', () => {
      const text = 'prose\n\n<div style="padding:8px">全部降级为基线';
      expect(split(text).pending).toBe('');
    });

    it('is not fooled by a `>` inside an attribute value', () => {
      // The old depth counters ended the tag at the first `>`; here that would
      // "complete" a tag that is still arriving.
      const { pending } = split('<div title="a > b" data-x="c');
      expect(pending).toBe('<div title="a > b" data-x="c');
    });
  });

  describe('unfinished constructs', () => {
    it('withholds a bare `<` and `</` at the end', () => {
      expect(split('text <').pending).toBe('<');
      expect(split('text </').pending).toBe('</');
    });

    it('withholds a closing tag that is still arriving', () => {
      expect(split('<b>bold</b').pending).toBe('</b');
    });

    it('withholds an unterminated comment even when it contains `>`', () => {
      expect(split('a <!-- note > here').pending).toBe('<!-- note > here');
    });

    it('releases a terminated comment', () => {
      expect(split('a <!-- note --> b').pending).toBe('');
    });

    it('withholds a rawtext element with no closer — its CSS is not renderable yet', () => {
      const { safe, pending } = split('intro\n<style>\n.card { color: red }\n');
      expect(safe).toBe('intro\n');
      expect(pending).toBe('<style>\n.card { color: red }\n');
    });

    it('releases a closed rawtext element, and is not fooled by markup inside it', () => {
      expect(split('<style>\n.a { }\n/* </div> */\n</style>\n<div>x</div>').pending).toBe('');
    });

    it('reports only the LAST unfinished construct, not an earlier complete one', () => {
      const { safe, pending } = split('<p>done</p>\n<span class="x');
      expect(safe).toBe('<p>done</p>\n');
      expect(pending).toBe('<span class="x');
    });
  });

  describe('prose that only looks like markup (never withheld)', () => {
    it('leaves a comparison alone', () => {
      expect(split('if a < b then').pending).toBe('');
      expect(split('5 <').pending).toBe('<'); // trailing `<` is genuinely ambiguous
      expect(split('5 < ').pending).toBe('');
    });

    it('leaves an autolink and an email alone', () => {
      expect(split('see <https://example.com/x> for more').pending).toBe('');
      expect(split('mail <user@host> please').pending).toBe('');
    });

    it('leaves a generic parameter alone', () => {
      expect(split('a value of Array<T> here').pending).toBe('');
    });

    it('leaves text with no angle bracket alone (fast path)', () => {
      expect(split('just words').pending).toBe('');
      expect(split('').pending).toBe('');
    });
  });

  describe('code is a sample, not markup', () => {
    it('does not withhold an unfinished tag inside a fenced block', () => {
      const text = '```html\n<div class="x"\n```\ndone';
      expect(split(text).pending).toBe('');
    });

    it('does not withhold an unfinished tag inside inline code', () => {
      expect(split('write `<div class="x` like that').pending).toBe('');
    });

    it('an UNCLOSED fence protects to the end — the tag inside it is still a sample', () => {
      // Streaming: the fence opened and its body is arriving. Withholding from the
      // `<` would tear the code block apart on every flush.
      expect(split('```html\n<div class="x"').pending).toBe('');
    });

    it('still withholds a tag OUTSIDE a closed fence', () => {
      const { pending } = split('```\ncode <div\n```\nnow <span style="a');
      expect(pending).toBe('<span style="a');
    });
  });

  /**
   * The renderer has its own, richer HTML scanner (web/src/utils/rich-blocks.ts)
   * for a different question: where a chunk boundary may fall. The two must agree
   * on the tail question, or the reducer would carry a fragment the renderer was
   * happy to render (or the reverse), which is exactly the split-brain that
   * produced the artifact in the first place.
   */
  describe('agrees with the renderer scanner on "does this text end mid-construct"', () => {
    const cases = [
      '<div style="padding:8',
      '<div style="padding:8px">ok',
      'plain text',
      'see <https://example.com> ok',
      '<style>\n.a { }\n',
      '<style>\n.a { }\n</style>\n',
      'a <!-- b',
      '`<div class="x`',
      '```\n<div\n```',
    ];

    it('same verdict on every case', async () => {
      const { endsMidConstruct } = await import('../../web/src/utils/rich-blocks.js');
      for (const text of cases) {
        expect(splitPendingMarkup(text).pending !== '', `disagreement on ${JSON.stringify(text)}`)
          .toBe(endsMidConstruct(text));
      }
    });
  });
});
