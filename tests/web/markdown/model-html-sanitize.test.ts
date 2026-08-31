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
import { scopeStyleHtml } from '@/utils/rich-blocks';

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
