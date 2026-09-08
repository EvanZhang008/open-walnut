import { useState } from 'react';
import { useRenderedMarkdown } from '@/hooks/useEntityLabels';
import type { InjectedBanner } from './injected-banner';
import '@/styles/injected-banner.css';

/**
 * One folded `[Banner]…[/Banner]` block that Walnut prepended to a user turn.
 *
 * Same muted disclosure row as `InjectedContextRow`/`ToolRunShell` (`tool-run-*`)
 * on purpose: the panel already has ONE visual language for "machine text inside a
 * user turn", and a second style would just be a third convention to keep in sync.
 * Closed by default — the human's own words are the point of the bubble.
 *
 * Markdown renders lazily, only once opened: a catch-up block is a whole
 * conversation recap, and a session's history can hold many of them.
 */
export function InjectedBannerRow({ banner, sessionCwd }: {
  banner: InjectedBanner;
  sessionCwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const html = useRenderedMarkdown(open ? banner.body : '', sessionCwd);
  return (
    <div
      className="tool-run-row injected-banner-row"
      data-testid="injected-banner"
      data-banner-name={banner.name}
    >
      <button
        className="tool-run-toggle"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <span className="tool-run-label">{banner.label}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && (
        <div className="tool-run-body" data-testid="injected-banner-body">
          <div
            className="chat-tool-block-result markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
