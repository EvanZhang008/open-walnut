/**
 * The task's browser use, as one small pill in the session header beside the servers' pill
 * (2026-11-09, the user: "same for brwoser, we only show as a small pill tehere people can click
 * and see detail"). Nothing live a session holds is drawn in its chat: the pill says the browser is
 * in use, and a click opens the Browser view (SessionBrowserCard: the live picture, Take over, Hand
 * back, Stop) in a popover over the page. Guard: tests/web/live-resources-header-only-guard.test.ts.
 *
 *   pill     "Browser" (or "Browser 2" for two tabs); amber "Sign in" while the agent asks the
 *            person to sign in, "Yours" while the person has the tab; nothing while no tab is used
 *   popover  on a click (or Enter): the Browser view, which asks for pictures only while it is open
 *
 * `compact`: the phone's top bar, beside the kebab: a browser window glyph in a 44 px target,
 * coloured by the same state.
 *
 * Overlay rules (web/src/AGENTS.md): portalled to <body>, placed by useMenuPlacement, one
 * useOverlayLayer layer (Escape and an outside pointerdown close it). Click only, never hover: the
 * view is large and opening it starts the picture stream.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import type { useBrowserView } from './useBrowserView';
import { SessionBrowserCard } from './SessionBrowserCard';
import type { BrowserViewTab } from './browser-view-model';
import '@/styles/session-browser-chip.css';

/** A browser window: its title bar and page. */
const BROWSER_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 9h18" />
    <circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" />
    <circle cx="9" cy="6.5" r="0.6" fill="currentColor" />
  </svg>
);

export type BrowserChipTone = 'live' | 'ask' | 'yours' | 'ended';

/** The pill's words and colour, from the task's tabs (null: no pill). */
export function browserChipLook(tabs: readonly Pick<BrowserViewTab, 'driving' | 'signIn' | 'title' | 'url' | 'tab'>[]): {
  label: string; tone: BrowserChipTone; title: string;
} | null {
  if (tabs.length === 0) return null;
  const asks = tabs.some((t) => t.signIn && !t.driving);
  const yours = tabs.some((t) => t.driving);
  const count = tabs.length > 1 ? ` ${tabs.length}` : '';
  const first = tabs[0]!;
  const name = first.title || first.url || `tab ${first.tab}`;
  if (asks) return { label: 'Sign in', tone: 'ask', title: 'The agent asks you to sign in, in its browser tab: show the Browser view' };
  if (yours) return { label: `Yours${count}`, tone: 'yours', title: 'You have the agent\'s browser tab: show the Browser view to hand it back' };
  return {
    label: `Browser${count}`,
    tone: 'live',
    title: tabs.length > 1 ? `This task uses ${tabs.length} tabs in your browser: show the Browser view` : `This task uses a tab in your browser (${name}): show the Browser view`,
  };
}

export function SessionBrowserChip({ taskId, view, compact = false }: {
  taskId: string;
  /** The task's tabs, read once by the panel (useBrowserView) for every pill it draws. */
  view: ReturnType<typeof useBrowserView>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, chipRef, cardRef, {
    align: 'start', preferSide: 'down', minHeight: 200, onAnchorLost: () => setOpen(false),
  });
  useOverlayLayer({ open, onClose: () => setOpen(false), refs: [cardRef, chipRef], trapFocus: false });

  const tabs = view.state?.tabs ?? [];
  const look = browserChipLook(tabs);
  // The last tab gone while the view is open: the pill stays until it closes, so the view can say why.
  const shown = !!look || open;
  // No tab and nothing to say about the last one: nothing to show, so no popover either.
  useEffect(() => { if (!view.state || (!look && !view.state.ended)) setOpen(false); }, [view.state, look]);
  if (!shown) return null;
  // The last tab gone with the view still open: grey, the view says why.
  const tone = look?.tone ?? 'ended';
  const label = look?.label ?? 'Browser';

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`session-browser-chip is-${tone}${compact ? ' is-compact' : ''}`}
        data-testid="session-browser-chip"
        data-header-pill="browser"
        data-short="B"
        data-tone={tone}
        aria-label={`${look?.title ?? 'Browser view'}`}
        title={look?.title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className="session-browser-chip-dot" aria-hidden="true" />
        {compact ? <span className="session-browser-chip-icon" aria-hidden="true">{BROWSER_ICON}</span> : <span className="session-browser-chip-label">{label}</span>}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="session-browser-popover"
              role="dialog"
              aria-label="Browser view"
              data-testid="session-browser-popover"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <SessionBrowserCard taskId={taskId} view={view} onClose={() => setOpen(false)} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
