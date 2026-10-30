/**
 * The frame that shows an html-app block while it is still arriving
 * (island-preview.ts says what it may and may not run).
 *
 * The frame is mounted once; each new text reaches it by `postMessage`, at most
 * every PREVIEW_EVERY_MS, so a fast stream costs a handful of redraws a second
 * and never a reload.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { islandPreviewDoc, isPreviewReady, previewUpdate, readPreviewHeight } from './island-preview';

/** The longest a new text waits before the frame draws it (ms). */
const PREVIEW_EVERY_MS = 120;

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function IslandPreview({ html, minHeight, maxHeight, onHeight, overlay }: {
  html: string;
  minHeight: number;
  maxHeight: number;
  /** The frame's drawn height, so the island that replaces it can take the same room. */
  onHeight?: (h: number) => void;
  /** Lie on top of the real island while that one loads underneath. */
  overlay?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [key] = useState(randomToken);
  const [nonce] = useState(randomToken);
  const srcDoc = useMemo(() => islandPreviewDoc(key, nonce), [key, nonce]);
  const [height, setHeight] = useState(minHeight);
  const [filled, setFilled] = useState(false);
  const latest = useRef(html);
  latest.current = html;
  const ready = useRef(false);
  const sent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  const flush = useRef(() => {
    timer.current = null;
    const win = frameRef.current?.contentWindow;
    if (!ready.current || !win || sent.current === latest.current) return;
    sent.current = latest.current;
    win.postMessage(previewUpdate(key, latest.current), '*');
  });

  // The frame says it is ready once, from its head; a parent that started
  // listening after that would wait for ever, so the frame's load event (bound at
  // commit, never missed) and its first height count as ready too.
  const markReady = useRef(() => {
    if (ready.current) return;
    ready.current = true;
    sent.current = null;
    flush.current();
  });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (isPreviewReady(e.data, key)) { markReady.current(); return; }
      const m = readPreviewHeight(e.data, key);
      if (!m) return;
      markReady.current();
      const h = Math.min(maxHeight, Math.max(minHeight, Math.ceil(m.h)));
      setHeight(h);
      setFilled(m.filled);
      onHeightRef.current?.(h);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, minHeight, maxHeight]);

  useEffect(() => {
    if (!ready.current || timer.current) return;
    timer.current = setTimeout(() => flush.current(), PREVIEW_EVERY_MS);
  }, [html]);

  return (
    <div
      className={`rich-app-live${overlay ? ' rich-app-live-overlay' : ''}`}
      data-testid="rich-app-live"
      style={{ height: `${height}px` }}
    >
      <iframe
        ref={frameRef}
        className="rich-app-live-frame"
        sandbox="allow-scripts"
        allowTransparency
        tabIndex={-1}
        aria-hidden="true"
        title="Interactive block preview"
        style={{ height: `${height}px`, background: 'transparent' }}
        srcDoc={srcDoc}
        onLoad={() => markReady.current()}
      />
      {filled
        ? <span className="rich-app-live-badge">{'⚙︎'} Building…</span>
        : <div className="rich-app-building rich-app-live-empty">{'⚙︎'} building interactive block…</div>}
    </div>
  );
}
