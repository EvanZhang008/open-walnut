/**
 * Render path for assistant text that may carry RAW HTML.
 *
 * Models write HTML now, and we render it natively — which means a reply can hold
 * real interactive DOM (a CSS-only radio stepper, a `<details>`, a form-ish
 * layout). One re-render of the whole message destroys that: setting innerHTML
 * rebuilds every node, so the radio the user clicked snaps back. During streaming
 * that happened on every delta.
 *
 * So a rich message is rendered as MANY blocks instead of one: the completed
 * top-level chunks (frozen — same html string every render, so React never
 * touches their DOM) plus one growing tail. splitRichChunks owns the invariant
 * that a frozen chunk can never change; this file owns the React mechanics that
 * turn that into "the DOM is never rewritten":
 *
 * 1. Chunk props are PRIMITIVES (text/kind/id), never the chunk object, so the
 *    memo() actually blocks the re-render — a fresh object per split would defeat
 *    it silently.
 * 2. The two branches carry distinct keys. React cannot turn a
 *    dangerouslySetInnerHTML node into a children node in place, and
 *    `hasRichContent` flips MID-STREAM the moment the model types its first tag.
 * 3. A chunk's React key is derived from its INDEX, never its text. A chunk
 *    promoted from tail to stable gains its boundary blank line, so a text-derived
 *    key changed exactly when the chunk was meant to become permanent — React
 *    unmounted it, which reloads an iframe island and resets widget state.
 *
 * A plain message (no tags at all) takes the original single-div path unchanged,
 * because none of the above buys anything there and markdown is happier parsed
 * whole.
 *
 * Two things model markup is NOT allowed to do, handled here rather than trusted:
 *  · CSS may not escape the MESSAGE — one scope id per RichMarkdown instance is
 *    stamped on the `.rich-blocks` wrapper, and scopeStyleHtml rewrites every rule
 *    under it. Message-level, not chunk-level: the `<style>` and the markup it
 *    styles are usually in different chunks (a blank line between them IS a chunk
 *    boundary), so a per-chunk scope could never match. `.rich-html-chunk` adds
 *    paint/layout containment on top.
 *  · a script may not run in the app's origin — a script-bearing chunk goes to a
 *    sandboxed iframe island (`allow-scripts` and nothing else, so it has no
 *    same-origin access, no cookies, no DOM of ours), never to innerHTML.
 */
import { memo, useEffect, useId, useMemo, useState, type RefObject } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import {
  splitRichChunks, scopeStyleHtml, hasRichContent, extractAppHtml, isAppComplete,
  collapseRawtextBlankLines, richScopeId, richChunkKey, type RichChunk,
} from '@/utils/rich-blocks';

/** An island can never be shorter than this or taller than this (px). */
const ISLAND_MIN_H = 40;
const ISLAND_MAX_H = 1600;

/**
 * Content Security Policy for every island document.
 *
 * The sandbox already denies same-origin access; this denies the NETWORK. Without
 * it a model-written script in a frame we mounted can beacon out (`fetch`,
 * `new Image().src`, a websocket) — from the user's machine, with whatever the
 * model chose to put in the URL. `default-src 'none'` closes all of that; images
 * and inline CSS/JS are the only things a visual widget actually needs.
 */
const ISLAND_CSP = '<meta http-equiv="Content-Security-Policy" content="'
  + "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  + '">';

/**
 * Markdown text, block-stable when it carries HTML.
 *
 * `scope` is the caller's stable per-message id (the same value it passes to
 * useSuggestSegments); it only has to be stable across re-renders of the SAME
 * message, and keeps two messages' scoped CSS from colliding. With no `scope` a
 * per-instance `useId` stands in, which is stable for as long as this component
 * instance lives.
 */
export function RichMarkdown({ text, cwd, scope, onClick, hostRef }: {
  text: string;
  /** Session cwd, so relative file paths in the prose stay clickable. */
  cwd?: string;
  scope?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /**
   * Selection-freeze host (useSelectionFrozen). Lands on the single markdown div
   * on the plain path, so an ordinary message's DOM is exactly what it was.
   */
  hostRef?: RefObject<HTMLDivElement | null>;
}) {
  const labelsVersion = useEntityLabelsVersion();
  const fallbackScope = useId();
  const scopeId = useMemo(() => richScopeId(scope ?? fallbackScope), [scope, fallbackScope]);
  // One pass per text change: the precheck and the split share a memo, and a
  // plain message never pays for the split at all.
  const split = useMemo(() => (hasRichContent(text) ? splitRichChunks(text) : null), [text]);
  const plainHtml = useMemo(
    () => (split ? '' : renderMarkdownWithRefs(text, cwd)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
    [split, text, cwd, labelsVersion],
  );

  if (!split) {
    return (
      <div
        key="plain"
        ref={hostRef}
        className="markdown-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: plainHtml }}
      />
    );
  }

  const chunks = split.tail ? [...split.stable, split.tail] : split.stable;
  return (
    <div key="rich" ref={hostRef} className="rich-blocks" data-rblk={scopeId} onClick={onClick}>
      {chunks.map((chunk, i) => {
        const key = richChunkKey(scopeId, i);
        if (chunk.kind === 'app') return <AppChunk key={key} chunk={chunk} scopeKey={key} />;
        return <RichChunkView key={key} text={chunk.text} kind={chunk.kind} scopeId={scopeId} cwd={cwd} />;
      })}
    </div>
  );
}

/**
 * One finished (or tail) markdown/HTML chunk.
 *
 * memo + primitive props is what freezes the DOM: an unchanged chunk re-renders
 * to the SAME `__html` string, which React diffs by string identity and skips.
 * Only the entity-label version can invalidate it, because a pill's text lives in
 * that store.
 */
const RichChunkView = memo(function RichChunkView({ text, kind, scopeId, cwd }: {
  text: string;
  kind: RichChunk['kind'];
  /** The MESSAGE's scope id — used to confine this chunk's CSS, not as a key. */
  scopeId: string;
  cwd?: string;
}) {
  // This is the ONE render path allowed to keep a model `<style>` (allowStyle),
  // because it is the one that scopes it: everywhere else a `<style>` would be
  // unconfined page-author CSS. useRenderedMarkdown can't carry the flag, so the
  // memo is hand-rolled here — and `useEntityLabelsVersion()` is subscribed in
  // this LEAF (what lets memo() block everything else) and listed as a dep, which
  // is exactly what that hook exists to make hard to forget. Keep both.
  const labelsVersion = useEntityLabelsVersion();
  const rendered = useMemo(
    // A blank line inside a `<style>`/`<script>` ends the raw-HTML block for
    // CommonMark, which markdown-parses the rest of the CSS into the element's
    // rawtext and destroys it. Collapsed HERE, not in renderMarkdownWithRefs: this
    // is the only surface that keeps a model `<style>` at all, and the chunker must
    // keep seeing the text byte-for-byte as it arrived.
    () => renderMarkdownWithRefs(collapseRawtextBlankLines(text), cwd, undefined, { allowStyle: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates the label lookups inside
    [text, cwd, labelsVersion],
  );
  const html = useMemo(() => scopeStyleHtml(rendered, scopeId), [rendered, scopeId]);
  return (
    <div
      className={`markdown-body rich-chunk${kind === 'html' ? ' rich-html-chunk' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/** A script-bearing chunk: sandboxed island once complete, placeholder while not. */
function AppChunk({ chunk, scopeKey }: { chunk: RichChunk; scopeKey: string }) {
  if (!isAppComplete(chunk)) {
    return <div className="rich-app-building">{'⚙︎'} building interactive block…</div>;
  }
  return <HtmlAppIsland html={extractAppHtml(chunk)} scopeKey={scopeKey} />;
}

/**
 * Height reporter injected into every island.
 *
 * An iframe has no intrinsic height, so without this the block is a fixed-height
 * box with its own scrollbar — which reads as broken. The frame measures itself
 * and posts up; the parent is the only thing allowed to resize it. `'*'` as the
 * target origin is not a leak: a sandboxed frame has an opaque origin, so there
 * is no origin to name, and the payload is a number the parent already knows.
 */
function heightReporter(key: string): string {
  return `<script>(function(){var k=${JSON.stringify(key)};function r(){try{parent.postMessage(`
    + `{t:'wn-island-h',k:k,h:document.documentElement.scrollHeight},'*')}catch(e){}}`
    + `r();addEventListener('load',r);`
    + `if(window.ResizeObserver)new ResizeObserver(r).observe(document.documentElement)})()</script>`;
}

/** Does this document already declare its own CSP? Then leave it alone. */
function hasCspMeta(html: string): boolean {
  return /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy/i.test(html);
}

/**
 * Wrap island content in a document.
 *
 * Content that already IS a document keeps its own head (a model that wrote
 * `<!doctype html>` chose its own styling); it only gets the reporter and the CSP.
 * Everything else gets a minimal frame. The font is spelled out rather than
 * inherited: a separate document inherits nothing from ours, so `font-family:
 * inherit` there would silently mean "browser default".
 */
function wrapIslandHtml(html: string, key: string): string {
  const reporter = heightReporter(key);
  const csp = hasCspMeta(html) ? '' : ISLAND_CSP;
  const head = html.trimStart().slice(0, 32).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    // A `<meta>` must land in the head to apply, so aim for an explicit `<head>`
    // first; failing that, right after `<html …>`, where the parser puts it in the
    // implied head anyway.
    const withCsp = csp === ''
      ? html
      : /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${csp}`)
        : /<html[^>]*>/i.test(html)
          ? html.replace(/<html[^>]*>/i, (m) => `${m}<head>${csp}</head>`)
          : csp + html;
    return /<\/body\s*>/i.test(withCsp)
      ? withCsp.replace(/<\/body\s*>/i, `${reporter}</body>`)
      : withCsp + reporter;
  }
  return `<!doctype html><html><head>${csp}<style>`
    + 'html,body{margin:0;background:transparent}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px}'
    + `</style></head><body>${html}${reporter}</body></html>`;
}

/**
 * Model-written HTML that runs: a seamless sandboxed iframe.
 *
 * `sandbox="allow-scripts"` and nothing else — NEVER allow-same-origin, which
 * together with allow-scripts would let the frame reach into the app's DOM,
 * storage and cookies and remove its own sandbox.
 */
const HtmlAppIsland = memo(function HtmlAppIsland({ html, scopeKey }: {
  html: string;
  scopeKey: string;
}) {
  const [height, setHeight] = useState(ISLAND_MIN_H);
  const srcDoc = useMemo(() => wrapIslandHtml(html, scopeKey), [html, scopeKey]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { t?: string; k?: string; h?: number } | null;
      if (!d || d.t !== 'wn-island-h' || d.k !== scopeKey || typeof d.h !== 'number') return;
      setHeight(Math.min(ISLAND_MAX_H, Math.max(ISLAND_MIN_H, Math.ceil(d.h))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [scopeKey]);

  return (
    <iframe
      className="rich-island"
      sandbox="allow-scripts"
      allowTransparency
      loading="lazy"
      title="Interactive block"
      style={{ height: `${height}px`, background: 'transparent' }}
      srcDoc={srcDoc}
    />
  );
});
