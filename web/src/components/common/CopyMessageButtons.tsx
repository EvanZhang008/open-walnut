import { useState, useRef, useEffect, useCallback } from 'react';
import { markdownToRichHtml } from '@/utils/markdown';
// Shared with the right-click "Copy as rich text" item (components/common/ContextMenu
// call sites) so both paths degrade the same way when the rich write is refused.
import { copyRichText, copyTextRobust } from '@/utils/clipboard';
import { log } from '@/utils/log';

/** ⧉ copy glyph — matches the kebab CopyItem style, sized for a message toolbar. */
const ICON_COPY = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="5" width="9" height="9" rx="1.5" />
    <path d="M11 5V3.5A1.5 1.5 0 009.5 2H3.5A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
  </svg>
);

const ICON_CHECK = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.5 3.5 6.5-8" />
  </svg>
);

type CopyState = null | 'md' | 'rich';

interface CopyMessageButtonsProps {
  /** Raw markdown source of the message (the on-screen text). */
  markdown: string;
}

/**
 * Two small copy actions for a chat message: copy the raw Markdown, or copy as
 * rich text (formatted HTML) for pasting into Docs/Word/email. Shows a transient
 * check-mark on success. Reused across session panels (Home + /sessions).
 */
export function CopyMessageButtons({ markdown }: CopyMessageButtonsProps) {
  const [done, setDone] = useState<CopyState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flash = useCallback((which: CopyState) => {
    setDone(which);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDone(null), 1200);
  }, []);

  const onCopyMd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    copyTextRobust(markdown)
      .then((result) => {
        if (result === 'failed') { log.warn('session', 'copy markdown failed', {}); return; }
        flash('md');
      })
      .catch((err) => log.warn('session', 'copy markdown failed', { error: String(err) }));
  }, [markdown, flash]);

  const onCopyRich = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const html = markdownToRichHtml(markdown);
    copyRichText(html, markdown)
      .then((result) => {
        if (result === 'failed') { log.warn('session', 'copy rich text failed', {}); return; }
        flash('rich');
      })
      .catch((err) => log.warn('session', 'copy rich text failed', { error: String(err) }));
  }, [markdown, flash]);

  return (
    <span className="msg-copy-actions">
      <button
        type="button"
        className="msg-copy-btn"
        onClick={onCopyMd}
        title="Copy as Markdown"
        aria-label="Copy as Markdown"
      >
        {done === 'md' ? ICON_CHECK : ICON_COPY}
        <span className="msg-copy-label">{done === 'md' ? 'Copied' : 'MD'}</span>
      </button>
      <button
        type="button"
        className="msg-copy-btn"
        onClick={onCopyRich}
        title="Copy as rich text (formatted — paste into Docs, Word, email)"
        aria-label="Copy as rich text"
      >
        {done === 'rich' ? ICON_CHECK : ICON_COPY}
        <span className="msg-copy-label">{done === 'rich' ? 'Copied' : 'Rich'}</span>
      </button>
    </span>
  );
}
