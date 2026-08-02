import type { MouseEvent } from 'react';
import { tokenizeUrls, shortenUrl } from '@/utils/url-display';

/**
 * Render PLAIN user-typed text with its http(s) URLs as compact, Slack-style
 * anchors — the full URL in `href`/`title`, a shortened label on screen.
 *
 * Why not `renderMarkdownWithRefs`? That path emits an HTML string for
 * `dangerouslySetInnerHTML` and applies markdown semantics, which is wrong for a
 * literal note (a `#` heading or `*` bullet the user typed must stay literal).
 * This keeps the text verbatim and only swaps URL runs for anchors.
 *
 * Click semantics are deliberately plain: clicking the LINK opens the link
 * (that's what links are for — the original ask), and stopPropagation keeps a
 * surrounding click-to-edit row from ALSO reacting to the same gesture. Editing
 * is the surrounding row's job, triggered by clicking anywhere that isn't the
 * link. (A "plain click edits, ⌘-click opens" variant was tried and reverted —
 * it broke the primary expectation that a link is clickable.)
 */
export function LinkifiedText({ text, max }: { text: string; max?: number }) {
  const tokens = tokenizeUrls(text);
  return (
    <>
      {tokens.map((t, i) => t.kind === 'text' ? (
        <span key={i}>{t.text}</span>
      ) : (
        <a
          key={i}
          href={t.href}
          target="_blank"
          rel="noopener noreferrer"
          title={t.href}
          className="linkified-url"
          onClick={(e: MouseEvent) => e.stopPropagation()}
        >
          {shortenUrl(t.href, max)}
        </a>
      ))}
    </>
  );
}
