import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, renderNoteMarkdown, markdownToRichHtml, renderToolResultWithRefs } from '@/utils/markdown';

/**
 * Contract: a bare URL autolinked inside CJK prose ends at the first CJK
 * punctuation mark — the prose after it is NOT part of the link.
 *
 * The recurring bug (reported 2026-08-12, screenshot: Personal AI chat): marked's
 * GFM `url` rule stops only at whitespace, but Chinese puts no space around
 * punctuation, so "打开 https://…/machine-learning-specialization,个人账户,enroll"
 * rendered with `,个人账户,enroll` INSIDE the anchor — a broken href and half
 * the sentence styled as a link. The retune lives on the global marked
 * singleton (cjkAwareUrlTokenizer, @/utils/markdown) with the cut semantics in
 * @/utils/url-display (trimUrlCjkTail), shared with the plain-text tokenizer.
 */

/** href attribute of the first <a> in the html */
function firstHref(html: string): string | null {
  return /<a[^>]*\bhref="([^"]*)"/.exec(html)?.[1] ?? null;
}

/** inner text of the first <a> in the html */
function firstAnchorText(html: string): string | null {
  return /<a[^>]*>([^<]*)<\/a>/.exec(html)?.[1] ?? null;
}

describe('autolink stops at CJK punctuation (the reported bug)', () => {
  const COURSERA = 'https://www.coursera.org/specializations/machine-learning-specialization';

  it('the exact reported message: fullwidth commas end the link', () => {
    const html = renderMarkdownWithRefs(`打开 ${COURSERA},个人账户,enroll CSCA 5622,开始学。`);
    expect(firstHref(html)).toBe(COURSERA);
    expect(firstAnchorText(html)).toBe(COURSERA);
    // The prose after the link survives as text, outside the anchor.
    expect(html).toContain('个人账户');
    expect(html).not.toContain('%E4%B8%AA%E4%BA%BA'); // "个人" percent-encoded into the href
  });

  it('the reported message verbatim: bold-wrapped URL + prose (session transcript form)', () => {
    // The actual transcript line: **打开 URL,个人账户,enroll CSCA 5622,开始学。**
    const html = renderMarkdownWithRefs(`**打开 ${COURSERA},个人账户,enroll CSCA 5622,开始学。**`);
    expect(firstHref(html)).toBe(COURSERA);
    expect(html).toContain('<strong>');
    expect(html).toContain('个人账户');
    expect(html).not.toContain('%E4%B8%AA%E4%BA%BA');
  });

  it('fullwidth ideographic period 。 ends the link', () => {
    const html = renderMarkdownWithRefs('见 https://example.com/path。下一句');
    expect(firstHref(html)).toBe('https://example.com/path');
    expect(html).toContain('下一句');
  });

  it('halfwidth comma followed by a CJK char ends the link (IME mixing)', () => {
    const html = renderMarkdownWithRefs('看 https://example.com/a,然后继续');
    expect(firstHref(html)).toBe('https://example.com/a');
    expect(html).toContain('然后继续');
  });

  it('halfwidth comma followed by ASCII stays inside the link (real query)', () => {
    const html = renderMarkdownWithRefs('https://example.com/q?a=1,2,3 works');
    expect(firstHref(html)).toBe('https://example.com/q?a=1,2,3');
  });

  // Explicit escapes — fullwidth vs halfwidth is invisible in source.
  it.each([
    ['、 U+3001', '、还有'],
    ['「 U+300C', '「引用」'],
    ['】 U+3011', '】后文'],
    [': U+FF1A', '：说明'],
    ['! U+FF01', '！感叹'],
    ['? U+FF1F', '？问题'],
    [') U+FF09', '）括号'],
    [', U+FF0C', '，下一段'],
  ])('fullwidth %s ends the link', (_ch, tail) => {
    const html = renderMarkdownWithRefs(`https://a.com/x${tail}`);
    expect(firstHref(html)).toBe('https://a.com/x');
  });

  it('halfwidth comma + CJK cut also re-backpedals a leftover trailing dot', () => {
    const html = renderMarkdownWithRefs('见 https://a.com/x.,继续');
    expect(firstHref(html)).toBe('https://a.com/x');
  });
});

describe('CJK characters that must STAY inside the link', () => {
  it('CJK letters in the path are part of the URL (wiki slugs)', () => {
    const html = renderMarkdownWithRefs('访问 https://zh.wikipedia.org/wiki/机器学习 学习');
    expect(firstHref(html)).toBe('https://zh.wikipedia.org/wiki/%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0');
    expect(firstAnchorText(html)).toBe('https://zh.wikipedia.org/wiki/机器学习');
  });

  it('CJK letters before a punctuation cut keep the letter run', () => {
    const html = renderMarkdownWithRefs('看 https://zh.wikipedia.org/wiki/机器学习,很好');
    expect(firstAnchorText(html)).toBe('https://zh.wikipedia.org/wiki/机器学习');
    expect(html).toContain('很好');
  });

  it('katakana middle dot ・ is a word char in slugs, not a cut', () => {
    const html = renderMarkdownWithRefs('见 https://ja.wikipedia.org/wiki/ウォルター・ホワイト です。');
    expect(firstAnchorText(html)).toBe('https://ja.wikipedia.org/wiki/ウォルター・ホワイト');
  });

  it('々 (iteration mark) is a word char, not punctuation', () => {
    const html = renderMarkdownWithRefs('https://ja.wikipedia.org/wiki/人々 を見る');
    expect(firstAnchorText(html)).toBe('https://ja.wikipedia.org/wiki/人々');
  });

  it('CJK IDN host: upstream marked never autolinks it — our retune must not crash on it', () => {
    // marked's url rule requires an ASCII host, so there is no anchor here at
    // all (pre-existing upstream behavior, pinned so a bump that changes it is
    // noticed). The retune must leave the text intact, not throw or mangle.
    const html = renderMarkdownWithRefs('打开 https://例子.中国/path 看看');
    expect(html).not.toContain('<a ');
    expect(html).toContain('例子');
  });
});

describe('non-CJK behavior is unchanged', () => {
  it('plain English URL + prose', () => {
    const html = renderMarkdownWithRefs('see https://example.com/a/b?q=1 then continue');
    expect(firstHref(html)).toBe('https://example.com/a/b?q=1');
  });

  it('trailing halfwidth period still backpedals (default GFM)', () => {
    const html = renderMarkdownWithRefs('go to https://example.com/path. Then stop');
    expect(firstHref(html)).toBe('https://example.com/path');
  });

  it('www. autolink keeps its synthesized http:// prefix after a CJK cut', () => {
    const html = renderMarkdownWithRefs('看 www.example.com/a,继续', undefined, undefined);
    expect(firstHref(html)).toBe('http://www.example.com/a');
  });

  it('email autolink is untouched', () => {
    const html = renderMarkdownWithRefs('mail foo@example.com now');
    expect(firstHref(html)).toBe('mailto:foo@example.com');
  });

  it('an explicit [label](href) link with CJK punct in the href is untouched', () => {
    const html = renderMarkdownWithRefs('[标签](https://example.com/a,b)');
    expect(firstHref(html)).toBe('https://example.com/a,b');
    expect(firstAnchorText(html)).toBe('标签');
  });

  it('URLs inside code spans are not autolinked by the tokenizer path', () => {
    // codespans go through linkifyPathsInCode, which applies the same cut.
    const html = renderMarkdownWithRefs('run `curl https://a.com/x,继续` now');
    expect(html).toContain('<code>');
    const codeHref = /<code>.*?href="([^"]*)"/.exec(html)?.[1];
    expect(codeHref).toBe('https://a.com/x');
  });

  it('a degenerate run (scheme + punct only) stays plain text', () => {
    const html = renderMarkdownWithRefs('看 https://。破句');
    expect(html).not.toContain('<a ');
  });
});

describe('every renderer shares the contract (same singleton / same rules)', () => {
  const CASE = '打开 https://a.com/x,个人账户 继续';

  it('copy-as-rich-text (markdownToRichHtml)', () => {
    const html = markdownToRichHtml(CASE);
    expect(firstHref(html)).toBe('https://a.com/x');
    expect(html).toContain('个人账户');
  });

  it('tool results (renderToolResultWithRefs)', () => {
    const html = renderToolResultWithRefs(CASE);
    expect(firstHref(html)).toBe('https://a.com/x');
  });

  it('task notes (renderNoteMarkdown, separate Marked instance)', () => {
    const html = renderNoteMarkdown(CASE);
    expect(firstHref(html)).toBe('https://a.com/x');
    expect(html).toContain('个人账户');
  });

  it('fenced code blocks get the same cut via linkifyPathsInCode', () => {
    const html = renderMarkdownWithRefs('```\ncurl https://a.com/x,继续\n```');
    const codeHref = /<code[^>]*>[\s\S]*?href="([^"]*)"/.exec(html)?.[1];
    expect(codeHref).toBe('https://a.com/x');
    expect(html).toContain('继续');
  });
});
