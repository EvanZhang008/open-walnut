/**
 * Ratchet: every message body that can re-render while a text selection lives
 * inside it takes its `dangerouslySetInnerHTML` prop from `useStableHtml`.
 *
 * Why a source ratchet and not only a browser test: React 19's `setProp` writes
 * `domElement.innerHTML` UNCONDITIONALLY, and `updateProperties` only skips a
 * prop when `nextProp === lastProp`. An inline `{{ __html: html }}` literal
 * allocates a new object every render, so the DOM is rebuilt on every re-render
 * even when the html is byte-identical — which silently killed
 * `useSelectionFrozen` when the app moved to React 19 (2026-09-08: "I select
 * text while the reply is still generating and the Copy/Ask pill gets
 * cancelled"). The mistake is a one-character-looking regression that reads
 * completely normal in review, so it gets pinned here as well as end-to-end in
 * tests/e2e/browser/session-stream-selection.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Files rendering prose that can re-render under a live selection.
 *
 * `whole: true` = the file must contain NO inline literal at all. The two chat
 * rows are `sites` instead because they also render click-to-open surfaces
 * (collapsed plan cards, tool-result bodies, compaction details) that only mount
 * on a click and are not part of this fix; what is pinned there is the MESSAGE
 * BODY, the one a reader selects while a turn streams.
 */
const HOSTS: Array<{ rel: string; whole?: boolean; sites?: RegExp[] }> = [
  { rel: 'web/src/components/chat/RichBlocks.tsx', whole: true },
  { rel: 'web/src/components/chat/SuggestCard.tsx', whole: true },
  { rel: 'web/src/components/common/ClaudeStreamView.tsx', whole: true },
  {
    rel: 'web/src/components/sessions/SessionMessage.tsx',
    // The user's own bubble. Rendering markdown INSIDE the attribute is the
    // worse form of the bug: the string is rebuilt too, so not even a string
    // compare could have saved it.
    sites: [/dangerouslySetInnerHTML=\{\{\s*__html:\s*renderMarkdownWithRefs\(/],
  },
  {
    rel: 'web/src/components/chat/ChatMessage.tsx',
    sites: [/dangerouslySetInnerHTML=\{\{\s*__html:\s*html\s*\?\?\s*''\s*\}\}/],
  },
];

const root = path.resolve(__dirname, '../..');

describe('message bodies use a stable innerHTML prop', () => {
  for (const host of HOSTS) {
    it(`${host.rel} passes no inline dangerouslySetInnerHTML literal for its message body`, () => {
      const src = readFileSync(path.join(root, host.rel), 'utf8');
      if (host.whole) {
        // Only JSX prop USES count; the doc comments in these files mention the
        // attribute by name, so match the prop form with its object literal.
        const inline = src.match(/dangerouslySetInnerHTML=\{\{/g) ?? [];
        expect(inline, `${host.rel} must take the prop from useStableHtml`).toEqual([]);
      }
      for (const site of host.sites ?? []) {
        expect(src, `${host.rel} must take the message body prop from useStableHtml`).not.toMatch(site);
      }
      expect(src).toContain('useStableHtml');
    });
  }

  it('useStableHtml holds one object per html string, without relying on useMemo', () => {
    const src = readFileSync(path.join(root, 'web/src/hooks/useStableHtml.ts'), 'utf8');
    // A ref, not useMemo: useMemo is documented as a hint React may drop, and a
    // dropped cache here is a destroyed selection rather than a slower render.
    expect(src).toContain('useRef');
    expect(src, 'no useMemo CALL (the doc block may name it)').not.toMatch(/useMemo\(/);
    // Keyed on the STRING, so an upstream memo that gets dropped and re-renders
    // an equal string still returns the same object.
    expect(src).toMatch(/ref\.current\.__html !== html/);
  });
});
