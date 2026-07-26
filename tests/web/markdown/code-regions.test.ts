import { describe, it, expect } from 'vitest';
import { codeRegions, renderMarkdownWithRefs, filePathsToHtml } from '@/utils/markdown';

/**
 * Regression contract for codeRegions() — the shared "which byte ranges will
 * markdown render as code" tracker used by every pass that injects raw HTML into
 * markdown SOURCE (filePathsToHtml, stripLeakedToolCalls, bareImagePathsToMarkdown).
 *
 * The 2026-07-25 bug: the old tracker was one regex, /```[\s\S]*?```|`[^`\n]+`/,
 * which closes a FOUR-backtick fence at the first inner ``` — so path linkification
 * ran inside the rest of the block and marked escaped the injected <a>, showing a
 * literal `<a class="file-link" data-rel-path=…>` on screen. Nested fences are the
 * normal shape of agent-written "copy this prompt verbatim" docs.
 */
const cwd = '/repo/pkg';

/** Offsets of a substring, for asserting containment in a region. */
function offsetOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return i;
}

const covers = (text: string, needle: string): boolean =>
  codeRegions(text).some(([s, e]) => {
    const i = offsetOf(text, needle);
    return i >= s && i + needle.length <= e;
  });

describe('codeRegions — fence nesting & length rules', () => {
  it('a 4-backtick fence is NOT closed by an inner 3-backtick fence', () => {
    const md = ['````', 'outer', '```', 'inner', '```', 'still outer', '````', 'prose'].join('\n');
    expect(covers(md, 'still outer')).toBe(true);
    expect(covers(md, 'prose')).toBe(false);
  });

  it('tilde fences are code, and are not closed by a backtick fence', () => {
    const md = ['~~~', 'code', '```', 'more code', '~~~', 'prose'].join('\n');
    expect(covers(md, 'more code')).toBe(true);
    expect(covers(md, 'prose')).toBe(false);
  });

  it('an unclosed fence runs to end of text', () => {
    const md = ['```', 'code', 'more'].join('\n');
    expect(covers(md, 'more')).toBe(true);
  });

  it('a fence info string is not a closer', () => {
    const md = ['```bash', 'cmd', '```', 'prose'].join('\n');
    expect(covers(md, 'cmd')).toBe(true);
    expect(covers(md, 'prose')).toBe(false);
  });

  it('indented (4-space) code blocks count as code', () => {
    const md = ['Example:', '', '    indented code', '', 'prose'].join('\n');
    expect(covers(md, 'indented code')).toBe(true);
    expect(covers(md, 'prose')).toBe(false);
  });

  it('a list item body indented 2 columns is NOT an indented code block', () => {
    const md = ['- item one', '  continuation line', '', 'prose'].join('\n');
    expect(covers(md, 'continuation line')).toBe(false);
  });

  it('inline spans are code; a stray backtick does not swallow the document', () => {
    const md = 'call `fn()` then a stray ` tick\n\nlater prose';
    expect(covers(md, 'fn()')).toBe(true);
    expect(covers(md, 'later prose')).toBe(false);
  });

  it('multi-backtick inline spans close only on an equal-length run', () => {
    const md = 'literal ``a ` b`` end';
    expect(covers(md, 'a ` b')).toBe(true);
    expect(covers(md, 'end')).toBe(false);
  });
});

describe('no literal <a class="file-link"> tags reach the user', () => {
  it('paths inside a nested-fence block render as links, not escaped tags', () => {
    const md = [
      'Copy this prompt verbatim:',
      '',
      '````',
      '**1. READ the docs**',
      '```',
      'tool.py get --path acme/docs/README',
      '```',
      '',
      '- `references/routing.md` (in this skill): find the owner',
      '- then read pkg/sub/module.ts for the impl',
      '````',
    ].join('\n');
    const html = renderMarkdownWithRefs(md, cwd);
    // The bug's fingerprint: an escaped anchor rendered as visible markup.
    expect(html).not.toContain('&lt;a class=');
    // Still clickable — linkifyPathsInCode does the job post-parse.
    expect(html).toContain('data-rel-path="references/routing.md"');
    expect(html).toContain('data-rel-path="pkg/sub/module.ts"');
    // And never nested anchors (broken DOM).
    expect(/<a [^>]*>[^<]*<a /.test(html)).toBe(false);
  });

  it('the pre-marked pass leaves nested-fence content untouched', () => {
    const md = ['````', '```', 'read pkg/sub/module.ts', '```', 'and pkg/other/file.ts', '````'].join('\n');
    expect(filePathsToHtml(md, cwd)).toBe(md);
  });

  it('tilde-fenced and indented code get linkified post-parse, not escaped', () => {
    for (const md of [
      ['~~~', 'read pkg/sub/module.ts here', '~~~'].join('\n'),
      ['Example:', '', '    read pkg/sub/module.ts here', ''].join('\n'),
    ]) {
      const html = renderMarkdownWithRefs(md, cwd);
      expect(html).not.toContain('&lt;a class=');
      expect(html).toContain('data-rel-path="pkg/sub/module.ts"');
    }
  });

  it('prose paths outside code are still linkified inline (no regression)', () => {
    const html = renderMarkdownWithRefs('see /etc/hosts/conf/app.yaml for config', cwd);
    expect(html).toContain('data-file-path="/etc/hosts/conf/app.yaml"');
  });
});

describe('performance guard', () => {
  it('a doc full of unmatched backticks does not go quadratic', () => {
    // 4k stray backticks across many paragraphs — the pre-fix whole-array
    // rescan-per-run shape. Must stay well under a frame budget.
    const md = Array.from({ length: 2000 }, (_, i) => `line ${i} \` tick\n\n`).join('');
    const t0 = performance.now();
    codeRegions(md);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
