/**
 * Model-written HTML through the real renderer: does the markup a widget needs
 * reach the DOM, and does its CSS stay in its own block?
 *
 * This is the only tier where `marked` + `dompurify` resolve (see
 * vitest.markdown.config.ts), so it is the only place the rendered STRING can be
 * inspected; the chunking rules live in the dependency-free
 * tests/web/rich-blocks.test.ts.
 *
 * ⚠️ DOMPurify is a PASSTHROUGH in this tier — do not write "the sanitizer drops
 * X" tests here, they pass vacuously. Measured with dompurify 3.3.1 +
 * tests/web/markdown/dom-setup.ts's linkedom window: `DOMPurify.isSupported` is
 * undefined (also when constructing an instance explicitly against that window),
 * and sanitize() returns its input verbatim — `<script>` included. Verifying the
 * FORBID_TAGS/FORBID_ATTR posture needs a real DOM, i.e. the Playwright tier.
 *
 * What IS real here: marked passes raw HTML through instead of escaping it (the
 * premise of the whole feature), and scopeStyleHtml is pure, so running it over
 * the genuine rendered output proves the CSS confinement end to end.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { collapseRawtextBlankLines, scopeStyleHtml } from '@/utils/rich-blocks';

const STEPPER = [
  '<style>',
  '.step { display: flex }',
  '.step input:checked + label { background: #333 }',
  '</style>',
  '<div class="step">',
  '<input type="radio" id="a" name="t"><label for="a">A</label>',
  '<input type="radio" id="b" name="t"><label for="b">B</label>',
  '</div>',
].join('\n');

describe('model-written HTML through renderMarkdownWithRefs', () => {
  it('passes the parts a CSS-only widget is made of through unescaped', () => {
    // allowStyle = the rich-chunk posture; the default posture FORBIDS <style>
    // (P0-2: an unscoped style on plan/tool-result surfaces blanked the console),
    // and asserting on it here would be vacuous anyway — see the header warning.
    const html = renderMarkdownWithRefs(STEPPER, undefined, undefined, { allowStyle: true });
    expect(html).toContain('<style>');
    expect(html).toContain('.step input:checked + label');
    expect(html).toContain('type="radio"');
    expect(html).toContain('<label for="a">');
    expect(html).not.toContain('&lt;input');
  });

  it('passes <details>/<summary> collapsible markup through', () => {
    const html = renderMarkdownWithRefs('<details><summary>More</summary>\n\nBody.\n\n</details>');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
  });

  it('confines the widget CSS to its own block', () => {
    // End to end: what the renderer hands to the DOM cannot restyle the console,
    // because every rule now needs this block's own attribute to match.
    const scoped = scopeStyleHtml(renderMarkdownWithRefs(STEPPER, undefined, undefined, { allowStyle: true }), 'blk1');
    expect(scoped).toContain('[data-rblk="blk1"] .step');
    expect(scoped).not.toMatch(/<style>\s*\.step/);
    expect(scoped).toContain('type="radio"');
  });

  it('confines a body/:root rule to the block instead of the page', () => {
    const scoped = scopeStyleHtml(renderMarkdownWithRefs('<style>body { background: #f00 }</style>', undefined, undefined, { allowStyle: true }), 'blk1');
    expect(scoped).toContain('[data-rblk="blk1"] { background: #f00 }');
    expect(scoped).not.toMatch(/<style>\s*body/);
  });

  it('scopes a style block even when nothing closed it', () => {
    // A real sanitizer always closes the tag; the browser would too, and then run
    // the CSS unscoped. The rewrite must not depend on that closer existing.
    const scoped = scopeStyleHtml('<style>body { background: #f00 }', 'blk1');
    expect(scoped).toContain('[data-rblk="blk1"] { background: #f00 }');
  });
});

/**
 * A blank line inside `<style>` used to destroy the CSS after it, and a comment
 * above an at-rule used to kill the at-rule. Both are what a model actually
 * writes: a readability gap between sections, a numbered comment heading over the
 * animation. Both were silent — the widget rendered, unstyled and unanimated.
 *
 * This is the only tier where the REAL renderer runs, so it is the only honest
 * place to assert the whole pipeline (collapse → marked → scope) end to end. The
 * DOM-level proof that the animation actually plays lives in the Playwright tier.
 */
describe('an animated widget the way a model writes it', () => {
  const ANIM_DEMO = [
    '<div class="anim-demo">',
    '<style>',
    '.anim-demo { border: 1px solid #ccc }',
    '.anim-demo .row { display: flex }',
    '',
    '/* 1. loop */',
    '@keyframes ad-flow { from { background-position: 0 0 } to { background-position: 40px 0 } }',
    '.anim-demo .pipe { animation: ad-flow 1s linear infinite }',
    '</style>',
    '',
    '<div class="row"><span class="pipe">·</span></div>',
    '</div>',
  ].join('\n');

  /** Exactly what RichChunkView does to one chunk. */
  function renderChunk(text: string, scope = 'blk1'): string {
    return scopeStyleHtml(
      renderMarkdownWithRefs(collapseRawtextBlankLines(text), undefined, undefined, { allowStyle: true }),
      scope,
    );
  }

  it('keeps all four CSS rules, scoped, past the blank line', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderChunk(ANIM_DEMO))![1];
    expect(css).toContain('[data-rblk="blk1"] .anim-demo { border: 1px solid #ccc }');
    expect(css).toContain('[data-rblk="blk1"] .anim-demo .row { display: flex }');
    expect(css).toContain('@keyframes ad-flow-blk1 {');
    expect(css).toContain('[data-rblk="blk1"] .anim-demo .pipe { animation: ad-flow-blk1 1s linear infinite }');
    // Nothing from the second half leaked out as markdown-parsed markup.
    expect(css).not.toContain('<p>');
    expect(css).not.toContain('<br>');
  });

  it('renames the keyframes consistently in the definition AND the reference', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderChunk(ANIM_DEMO))![1];
    const defined = /@keyframes\s+([\w-]+)/.exec(css)![1];
    const used = /animation:\s*([\w-]+)/.exec(css)![1];
    expect(used).toBe(defined);
    expect(defined).toBe('ad-flow-blk1'); // scoped, so two replies cannot collide
  });

  it('leaves the markup it styles intact', () => {
    const html = renderChunk(ANIM_DEMO);
    expect(html).toContain('<div class="anim-demo">');
    expect(html).toContain('<span class="pipe">');
  });

  it('does not rewrite a fenced CSS sample that shows the same shape', () => {
    // A doc TEACHING this CSS keeps its blank lines and renders as code, not style.
    const doc = ['Like this:', '', '```html', ...ANIM_DEMO.split('\n'), '```'].join('\n');
    const html = renderMarkdownWithRefs(collapseRawtextBlankLines(doc), undefined, undefined, { allowStyle: true });
    expect(html).toContain('<pre>');
    expect(html).toContain('&lt;style&gt;');
    expect(html).toMatch(/display: flex \}\n\n/); // the sample's blank line survives
  });
});
