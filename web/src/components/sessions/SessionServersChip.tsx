/**
 * The web servers a session started, as one chip in its header's title row, beside the
 * wait and the other labels (where the user put the wait: "put it up with the task and its
 * tags, on the left ... hover shows the details", 2026-10-31). Not in the tools row
 * (SessionPanel.tsx: "Do not add more here").
 *
 *   chip   ":5173" for one web page, "Web 3" for more; a server that is not a web page counts
 *          only when there is no web page (":2014", "2 servers"); nothing while none runs. The
 *          servers are a pill here only, never a card in the chat (2026-11-09, the user: "not
 *          show bottom,only show the top one there"; tests/web/live-resources-header-only-guard.test.ts)
 *   card   on hover, focus or a tap: the session's server list (SessionServerList), each
 *          row with Open (into the Web view) and Stop (asked first, as everywhere)
 *
 * `compact`: the phone's top bar, beside the kebab: a globe and the count in a 44 px target.
 *
 * Overlay rules (web/src/AGENTS.md): the card is portalled to <body>, placed by
 * useMenuPlacement, and is one useOverlayLayer layer (so a Stop popover opened in it is the
 * layer above, and one Escape closes that alone); an outside pointerdown closes it, as does
 * the pointer leaving both the chip and the card while nothing in the card was pressed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import type { SessionServersState } from '@/hooks/useSessionServers';
import type { SessionServer } from '@/api/session-servers';
import { SessionServerList } from './SessionServerList';
import { openable, serverLabel } from './session-server-label';
import '@/styles/session-servers.css';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;

export const WEB_GLOBE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
  </svg>
);

/** The chip's words: the one page's port, else "Web" and how many; with no web page, the servers. */
export function serversChipLabel(pages: readonly Pick<SessionServer, 'port'>[], all: readonly Pick<SessionServer, 'port'>[] = pages): string {
  if (pages.length === 1) return `:${pages[0]!.port}`;
  if (pages.length > 1) return `Web ${pages.length}`;
  return all.length === 1 ? `:${all[0]!.port}` : `${all.length} servers`;
}

export function SessionServersChip({ servers, activePort, onOpen, compact = false }: {
  servers: SessionServersState;
  /** The port the Web view shows now, if it is open on one. */
  activePort: number | null;
  onOpen: (server: SessionServer) => void;
  compact?: boolean;
}) {
  const hostName = useHostDisplayLabels();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // Opened by a click, or pressed inside: it stays until a click outside or Escape.
  const held = useRef(false);
  const placement = useMenuPlacement(open, chipRef, cardRef, {
    align: 'start', preferSide: 'down', minHeight: 120, onAnchorLost: () => setOpen(false),
  });

  const later = useCallback((next: boolean, ms: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!next && held.current) return;
      setOpen(next);
    }, ms);
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  useEffect(() => { if (!open) held.current = false; }, [open]);

  useOverlayLayer({ open, onClose: () => setOpen(false), refs: [cardRef, chipRef], trapFocus: false });

  const all = servers.servers;
  const pages = all.filter(openable);
  // No server: no chip (and no card left over from one).
  useEffect(() => { if (all.length === 0) setOpen(false); }, [all.length]);
  if (all.length === 0) return null;

  const label = serversChipLabel(pages, all);
  const title = pages.length === 1
    ? `:${pages[0]!.port} ${pages[0]!.title || serverLabel(pages[0]!)}, a web server this session started`
    : pages.length > 1 ? `${pages.length} web servers this session started`
      : all.length === 1 ? `:${all[0]!.port} ${serverLabel(all[0]!)}, a server this session started` : `${all.length} servers this session started`;
  const hostLabel = servers.host && servers.host !== '__local__' ? hostName(servers.host) : '';
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`session-web-chip${compact ? ' is-compact' : ''}`}
        data-testid="session-web-chip"
        data-header-pill="web"
        aria-label={`${title}: show them, to open or stop`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => later(true, OPEN_DELAY_MS)}
        onMouseLeave={() => later(false, CLOSE_DELAY_MS)}
        onFocus={() => setOpen(true)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
          // A click on a card the hover already opened keeps it; otherwise it toggles.
          if (open && !held.current) { held.current = true; return; }
          held.current = !open;
          setOpen(!open);
        }}
      >
        <span className="session-web-chip-dot" aria-hidden="true" />
        {compact
          ? <><span className="session-web-chip-icon" aria-hidden="true">{WEB_GLOBE_ICON}</span><span className="session-web-chip-count">{pages.length || all.length}</span></>
          : <span className="session-web-chip-label">{label}</span>}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="session-web-card"
              role="dialog"
              aria-label="Servers this session started"
              data-testid="session-web-card"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => { e.stopPropagation(); held.current = true; }}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => later(true, 0)}
              onMouseLeave={() => later(false, CLOSE_DELAY_MS)}
            >
              <SessionServerList
                variant="list"
                dense
                servers={servers.servers}
                activePort={activePort}
                stopping={servers.stopping}
                stopErrors={servers.stopErrors}
                hostLabel={hostLabel}
                onOpen={(s) => { setOpen(false); onOpen(s); }}
                onStop={(s) => { void servers.stop(s); }}
                onClose={() => setOpen(false)}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
