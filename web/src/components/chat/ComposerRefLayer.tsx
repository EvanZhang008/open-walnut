/**
 * The layer that draws the composer's references as pills (composer-ref-pills.ts).
 *
 * It sits exactly over the textarea, behind it, with the textarea's own font, padding
 * and width, and draws the same text; while it is on, the textarea's text is transparent
 * (`has-ref-pills`) and only its caret and selection show. The textarea keeps every
 * input behaviour; this layer only paints. It is placed against its offset parent
 * (`.chat-input-container`) from the two boxes, so the textarea's flex layout is left
 * alone, and follows the textarea's size and scroll.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ComposerSegment } from './composer-ref-pills';
import '@/styles/composer-ref-pills.css';

/** The textarea styles the layer must share so every character lands in the same place. */
const COPIED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings', 'fontKerning',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'textRendering',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'direction',
] as const;

export function ComposerRefLayer({ textareaRef, segments }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  segments: readonly ComposerSegment[];
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const layer = layerRef.current;
    if (!ta || !layer) return;
    const place = () => {
      const host = layer.offsetParent as HTMLElement | null;
      if (!host) return;
      const cs = getComputedStyle(ta);
      const s = layer.style;
      for (const k of COPIED) s[k] = cs[k];
      s.borderStyle = 'solid';
      s.borderColor = 'transparent';
      const t = ta.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      // The scrollbar a long text gets takes width from the text; the layer has none.
      const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth - borders);
      s.left = `${t.left - h.left - host.clientLeft}px`;
      s.top = `${t.top - h.top - host.clientTop}px`;
      s.width = `${ta.offsetWidth - scrollbar}px`;
      s.height = `${ta.offsetHeight}px`;
      if (textRef.current) textRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
    };
    placeRef.current = place;
    place();
    // Placed on the next frame: writing the layer's size inside the observer's own
    // callback is the "ResizeObserver loop" error WebKit reports.
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(ta);
    if (ta.parentElement) ro?.observe(ta.parentElement);
    const onScroll = () => { if (textRef.current) textRef.current.style.transform = `translateY(${-ta.scrollTop}px)`; };
    ta.addEventListener('scroll', onScroll);
    window.addEventListener('resize', later);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      ta.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', later);
    };
  }, [textareaRef]);

  // New text may grow the box or move its scroll: place again after it is drawn.
  useLayoutEffect(() => { placeRef.current(); }, [segments]);

  const last = segments[segments.length - 1];
  return (
    <div ref={layerRef} className="chat-input-ref-layer" aria-hidden="true" data-testid="composer-ref-layer">
      <div ref={textRef} className="chat-input-ref-layer-text">
        {segments.map((seg) => {
          const p = seg.pill;
          if (!p) return <span key={seg.start}>{seg.text}</span>;
          return (
            <span
              key={seg.start}
              className="composer-ref-pill"
              data-kind={p.kind}
              data-source={p.sourceId}
              data-testid="composer-ref-pill"
            >
              <span className="composer-ref-pill-open">{p.open}</span>
              {p.lead && <span className="composer-ref-pill-lead">{p.lead}</span>}
              <span className="composer-ref-pill-label">{p.label}</span>
              {p.close && <span className="composer-ref-pill-close">{p.close}</span>}
            </span>
          );
        })}
        {/* A final newline makes an empty last line the textarea draws; keep its height. */}
        {last && last.text.endsWith('\n') ? '\u200b' : null}
      </div>
    </div>
  );
}
