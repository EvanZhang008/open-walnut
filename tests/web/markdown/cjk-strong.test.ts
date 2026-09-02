import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, renderNoteMarkdown, markdownToRichHtml } from '@/utils/markdown';

/**
 * Contract: `**加粗句。**下一句` renders bold in CJK prose.
 *
 * The reported bug (2026-09-01, screenshot of a session reply): four literal
 * asterisks in the middle of a paragraph — `**便签的比喻还成立。**之前我说:`. Not a
 * regression and not a marked bug: CommonMark closes `**` only on a RIGHT-FLANKING
 * run, and a run preceded by punctuation and followed by a letter is not
 * right-flanking. English earns that rule (`**a.**b` is ambiguous). Chinese does
 * not: a bold sentence ends in `。` or `?` and the next sentence starts
 * immediately, with no space anywhere.
 *
 * `cjkStrongExtension` (@/utils/markdown) is deliberately ADDITIVE — it may only
 * create emphasis where marked found none. The last describe block is what pins
 * that: every shape marked already handles must come out unchanged.
 */

/** Strip the paragraph wrapper so the assertions read like the source. */
function inline(md: string): string {
  return renderMarkdownWithRefs(md).replace(/^<p>/, '').replace(/<\/p>\n?$/, '').trim();
}

describe('the reported shapes now bold', () => {
  it('the exact reported clause', () => {
    expect(inline('**便签的比喻还成立,错的是"谁在改便签"。**之前我说:host 表那边一直在变'))
      .toBe('<strong>便签的比喻还成立,错的是&quot;谁在改便签&quot;。</strong>之前我说:host 表那边一直在变');
  });

  it('a halfwidth question mark inside Chinese prose (the second reported clause)', () => {
    expect(inline('**那和 STRICT_DNS 还有什么区别?**区别在"一张便签"还是"整张表":'))
      .toBe('<strong>那和 STRICT_DNS 还有什么区别?</strong>区别在&quot;一张便签&quot;还是&quot;整张表&quot;:');
  });

  it('every punctuation mark a Chinese sentence can end on', () => {
    for (const p of ['。', '?', '!', ',', '、', ':', ';', ')', '」', '…', '?', '!', ',']) {
      expect(inline(`**中文${p}**后面`), `closer after ${p}`).toBe(`<strong>中文${p}</strong>后面`);
    }
  });

  it('mid-paragraph, not just at the start', () => {
    expect(inline('前面的话**中文。**后面的话')).toBe('前面的话<strong>中文。</strong>后面的话');
  });

  it('keeps inline code inside the bold run', () => {
    expect(inline('**配置带 `DnsRefreshRate: 15s`。**而 Envoy 是定时器驱动的'))
      .toBe('<strong>配置带 <code>DnsRefreshRate: 15s</code>。</strong>而 Envoy 是定时器驱动的');
  });

  it('reaches the notes renderer and the copy-as-rich-text path too', () => {
    // Separate Marked instances; each needs its own registration, and a reader
    // copying a reply into a doc must get the same bold.
    expect(renderNoteMarkdown('**中文。**后面')).toContain('<strong>中文。</strong>');
    expect(markdownToRichHtml('**中文。**后面')).toContain('<strong>中文。</strong>');
  });
});

describe('CommonMark still owns everything it decides well', () => {
  it('leaves English `**a.**b` literal', () => {
    // No CJK in the run, so the no-word-spaces argument does not apply and the
    // ambiguity CommonMark is protecting against is real.
    expect(inline('**a.**b')).toBe('**a.**b');
    expect(inline('**Note.**Next')).toBe('**Note.**Next');
  });

  it('does not lengthen a span marked already closes', () => {
    // marked closes at the FIRST `**`; a later punctuation-adjacent one must not
    // be preferred, or `<strong>a</strong>b。**c` would become `<strong>a**b。</strong>c`.
    expect(inline('**中文**尾。**后')).toBe('<strong>中文</strong>尾。**后');
    expect(inline('**a**b。**c')).toBe('<strong>a</strong>b。**c');
  });

  it('leaves the shapes that already worked exactly as they were', () => {
    expect(inline('**中文**后面')).toBe('<strong>中文</strong>后面');
    expect(inline('**中文。** 后面')).toBe('<strong>中文。</strong> 后面');
    expect(inline('**中文。**,后面')).toBe('<strong>中文。</strong>,后面');
    expect(inline('**中文。**(注)')).toBe('<strong>中文。</strong>(注)');
  });

  it('a `**` inside a code span is a SAMPLE, not a delimiter', () => {
    expect(inline('`**中文。**后面`')).toBe('<code>**中文。**后面</code>');
    // …and a code span holding `**` cannot become the closer of a real run.
    expect(inline('**中文 `a**b` 的。**后面'))
      .toBe('<strong>中文 <code>a**b</code> 的。</strong>后面');
  });

  it('never spans a blank line', () => {
    const html = renderMarkdownWithRefs('**开头\n\n结尾。**后面');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**开头');
  });

  it('leaves a lone or unpaired run alone', () => {
    expect(inline('**中文。')).toBe('**中文。');
    expect(inline('中文。**后面')).toBe('中文。**后面');
  });

  it('a bullet list is still a bullet list', () => {
    // `*` is the list marker; the extension only ever looks at `**` runs.
    const html = renderMarkdownWithRefs('* 第一项\n* 第二项');
    expect(html).toContain('<li>第一项</li>');
    expect(html).not.toContain('<strong>');
  });

  it('三个星号 still resolves to em inside strong', () => {
    expect(inline('***中文***后面')).toBe('<em><strong>中文</strong></em>后面');
  });
});
