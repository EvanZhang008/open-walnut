/**
 * The servers a session started, inside its Web view: a strip of chips for its web pages
 * over an open page (every server, with its details, one click away under "Servers"), or
 * the list with details when nothing is open yet.
 *
 * Open puts the server in the Web view (its `localhost:<port>` address, which the
 * server tunnels when the session's host is remote). Stop asks once, in a small popover
 * under the button ("Stop :5173?"), then the host signals that server's process group;
 * the agent and the terminal that started it keep running. The popover never covers the
 * button that opened it, so a double click cannot confirm.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { SessionServer } from '@/api/session-servers';
import { serverKey } from '@/hooks/useSessionServers';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { copyTextRobust } from '@/utils/clipboard';
import { formatAge, serverAge, openable, serverLabel, shortCommand } from './session-server-label';

export interface SessionServerListProps {
  servers: SessionServer[];
  /** The port of the page the Web view shows now, to mark its chip. */
  activePort?: number | null;
  stopping: ReadonlySet<string>;
  stopErrors: ReadonlyMap<string, string>;
  /** Host label for a remote session ("on devbox"), empty for this machine. */
  hostLabel?: string;
  onOpen: (server: SessionServer) => void;
  onStop: (server: SessionServer) => void;
  variant: 'strip' | 'list';
  /** Strip: show every server with its details (the list, over the page). */
  onShowAll?: () => void;
  /** Strip: that list is open now. */
  showingAll?: boolean;
  /** List shown over a page: close it. */
  onClose?: () => void;
  /** List: it was opened for a server that is not a web page: bring those rows into view, marked a moment. */
  pointAtOthers?: boolean;
  /** List: its heading (default "Servers this session started"). */
  title?: string;
  /** List: one line a server (port, name, Open, Stop), for a card; the command, uptime and pid
   *  stay in the Web view's list and in the row's tooltip. */
  dense?: boolean;
}

function bindLabel(s: SessionServer): string {
  if (s.loopbackOnly) return 'this host only';
  if (s.addresses.some((a) => a === '*' || a === '0.0.0.0' || a === '::')) return 'all interfaces';
  return s.addresses.join(', ');
}

function keeps(s: SessionServer): string {
  return s.via === 'terminal' ? 'The agent and the terminal keep running.' : 'The agent keeps running.';
}

function stopTitle(s: SessionServer): string {
  if (s.stopScope === 'none') return `:${s.port} runs inside the agent's own process group, so Walnut will not stop it. Ask the session to stop it.`;
  if (s.stopScope === 'process') return `Stop :${s.port}. Its process group also holds other work, so only pid ${s.pid} is signalled.`;
  return `Stop :${s.port} and the job it belongs to. ${keeps(s)}`;
}

function stopScopeLine(s: SessionServer): string {
  return s.stopScope === 'process'
    ? `Stops only this server's process (pid ${s.pid}). ${keeps(s)}`
    : `Stops this server and anything else its command started (pid ${s.pid}). ${keeps(s)}`;
}

/** What a chip calls a server: its page's title, else the program (one rule, whatever else runs). */
export function chipName(s: Pick<SessionServer, 'title' | 'name' | 'command'>): string {
  return s.title || serverLabel(s);
}


/** Web pages first, then anything else; by port within each. */
function ordered(servers: SessionServer[]): SessionServer[] {
  return [...servers].sort((a, b) => Number(!openable(a)) - Number(!openable(b)) || a.port - b.port);
}

/** The gap between chips (session-servers.css, .session-servers-strip-chips). */
const CHIP_GAP = 6;
/** The shortest a strip chip's name is cut to (px) before chips show their port alone. */
const MIN_CUT = 40;

/** How a chip names its server: by its name, a short one, or its port alone. */
type ChipForm = 'full' | 'short' | 'port';

/** `sent`: confirmed, the stop is on its way (the popover holds until it is answered). */
/** `placeAt`: what the popover is placed against (the Stop itself in the strip; in a row, the
 *  row's first action, so the popover opens left of the Open and Stop columns and never covers
 *  the next row's Stop). */
interface Confirming { key: string; anchor: HTMLElement; placeAt: HTMLElement; sent?: boolean }

function StopPopover({ server, anchor, placeAt, sent, onConfirm, onCancel }: {
  server: SessionServer; anchor: HTMLElement; placeAt: HTMLElement; sent: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const placeRef = useMemo(() => ({ current: placeAt }), [placeAt]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const placement = useMenuPlacement(true, placeRef, ref, { align: 'right', gap: 6, minHeight: 90, onAnchorLost: onCancel });
  useOverlayLayer({
    open: true,
    refs: [ref, anchorRef],
    // A press elsewhere (another chip, Open on another row) cancels and does what it pressed.
    passOutsideClick: true,
    onClose: (reason) => { onCancel(); if (reason === 'escape') anchor.focus({ preventScroll: true }); },
  });
  // The keyboard lands on Cancel once the popover is placed (never on the destructive button).
  const placed = placement !== null;
  useEffect(() => { if (placed) cancelRef.current?.focus({ preventScroll: true }); }, [placed]);
  // A second press on the Stop that opened it (a double click) took the focus: give it back.
  useEffect(() => {
    const refocus = () => requestAnimationFrame(() => cancelRef.current?.focus({ preventScroll: true }));
    anchor.addEventListener('click', refocus);
    return () => anchor.removeEventListener('click', refocus);
  }, [anchor]);
  // A click into the page below goes to its frame, which this document never sees: the
  // window losing focus is the sign.
  useEffect(() => {
    const onBlur = () => onCancel();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [onCancel]);

  return createPortal(
    <div ref={ref} className="session-server-popover" style={{ ...menuPlacementStyle(placement), maxHeight: undefined }} role="dialog"
      aria-label={`Stop the server on port ${server.port}?`} data-testid="session-server-stop-popover"
      onPointerDown={(e) => e.stopPropagation()}>
      <div className="session-server-popover-title">
        Stop <span className="session-server-port">:{server.port}</span> {server.title || serverLabel(server)}?
      </div>
      <div className="session-server-popover-body">{stopScopeLine(server)}</div>
      <div className="session-server-popover-actions">
        <button ref={cancelRef} type="button" className="session-server-btn" onClick={onCancel} disabled={sent}>Cancel</button>
        <button type="button" className="session-server-btn session-server-btn-danger" data-testid="session-server-stop-confirm" onClick={onConfirm} disabled={sent}>
          {sent ? 'Stopping…' : 'Stop server'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" className={`session-server-btn session-server-btn-icon session-server-copy${copied ? ' session-server-copy-done' : ''}`}
      title={copied ? 'Copied' : 'Copy the full command'} aria-label={copied ? 'Copied' : 'Copy the full command'}
      onClick={() => { void copyTextRobust(command).then((r) => setCopied(r !== 'failed')); }}>
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="3.5" y="3.5" width="6.5" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2 8V2.8C2 2.4 2.4 2 2.8 2H7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
      )}
    </button>
  );
}

export function SessionServerList({
  servers, activePort, stopping, stopErrors, hostLabel, onOpen, onStop, variant, onShowAll, showingAll, onClose,
  pointAtOthers, title = 'Servers this session started', dense = false,
}: SessionServerListProps) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const list = useMemo(() => ordered(servers), [servers]);
  const cancel = useMemo(() => () => setConfirming(null), []);
  // A sent stop closes its popover once it is answered (the server left, or it failed).
  const answered = !!confirming?.sent && !stopping.has(confirming.key);
  useEffect(() => { if (answered) setConfirming(null); }, [answered]);
  // A confirm for a server that left the list is moot.
  const confirmed = confirming ? list.find((s) => serverKey(s) === confirming.key) : undefined;
  useEffect(() => { if (confirming && !confirmed) setConfirming(null); }, [confirming, confirmed]);

  // The strip's chips are laid out, never scrolled or cut: every page by its name when they
  // all fit, else by names cut to the one length that fills the row, else by its port alone, else as
  // many as fit (the rest are under "+N", the page shown always kept). Every chip has the same
  // form, whichever is shown, so a switch only recolours: no chip moves under the pointer. A
  // measurer draws each chip every way out of sight, so the choice is made before paint.
  const chipsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ form: ChipForm; hidden: string[]; cut?: number }>({ form: 'full', hidden: [] });
  const relayout = useCallback(() => {
    const box = chipsRef.current;
    const m = measureRef.current;
    if (!box || !m || box.clientWidth === 0) return;
    const avail = box.clientWidth;
    // Each chip by its whole name and by its port alone, and how wide that name is.
    const widths = new Map<string, { full: number; port: number; name: number }>();
    let activeKey: string | undefined;
    m.querySelectorAll<HTMLElement>('[data-measure]').forEach((el) => {
      const key = el.dataset.measure!;
      const w = widths.get(key) ?? { full: 0, port: 0, name: 0 };
      if (el.dataset.form === 'port') w.port = el.offsetWidth;
      else { w.full = el.offsetWidth; w.name = el.querySelector<HTMLElement>('.session-server-name')?.offsetWidth ?? 0; }
      if (el.dataset.active !== undefined) activeKey = key;
      widths.set(key, w);
    });
    const keys = [...widths.keys()];
    // The row's width with these chips in `form`, as gaps go between chips.
    const width = (form: 'full' | 'port', ks: string[]) => ks.reduce((a, k, i) => a + widths.get(k)![form] + (i > 0 ? CHIP_GAP : 0), 0);
    // The row with every name cut to `cut` px: a name longer than that loses the difference.
    const cutTo = (cut: number) => keys.reduce((a, k, i) => {
      const w = widths.get(k)!;
      return a + w.full - Math.max(0, w.name - cut) + (i > 0 ? CHIP_GAP : 0);
    }, 0);
    let next: { form: ChipForm; hidden: string[]; cut?: number } | undefined;
    if (width('full', keys) <= avail) next = { form: 'full', hidden: [] };
    else if (cutTo(MIN_CUT) <= avail) {
      let cut = MIN_CUT;
      while (cutTo(cut + 2) <= avail) cut += 2;
      next = { form: 'short', hidden: [], cut };
    } else if (width('port', keys) <= avail) next = { form: 'port', hidden: [] };
    if (!next) {
      // By port, as many as fit in order; the page shown keeps its place first.
      const kept: string[] = activeKey ? [activeKey] : [];
      const hidden: string[] = [];
      for (const k of keys) if (k !== activeKey) (width('port', [...kept, k]) <= avail ? kept : hidden).push(k);
      next = { form: 'port', hidden };
    }
    const n = next;
    setFit((f) => (f.form === n.form && f.cut === n.cut && f.hidden.join() === n.hidden.join() ? f : n));
  }, []);
  useLayoutEffect(relayout, [relayout, servers, activePort, stopping, variant]);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(relayout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [relayout, variant]);

  // Opened for a server that is not a web page: those rows, in view and marked for a moment.
  const listRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!pointAtOthers || variant !== 'list') return;
    listRef.current?.querySelector('[data-other]')?.scrollIntoView?.({ block: 'nearest' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2200);
    return () => clearTimeout(t);
  }, [pointAtOthers, variant]);

  const stopButton = (s: SessionServer, inStrip: boolean) => {
    const key = serverKey(s);
    const busy = stopping.has(key);
    // The same button says "Stopping…" while it runs: the row keeps its width and its focus.
    return (
      <button type="button"
        className={`session-server-btn${inStrip ? ' session-servers-strip-stop' : ' session-server-row-stop'}${confirming?.key === key ? ' session-server-btn-armed' : ''}`}
        disabled={s.stopScope === 'none' || busy}
        title={busy ? 'Stopping…' : stopTitle(s)}
        aria-label={busy ? `Stopping the server on port ${s.port}` : `Stop the server on port ${s.port}`}
        aria-haspopup="dialog"
        aria-expanded={confirming?.key === key}
        onClick={(e) => {
          const anchor = e.currentTarget;
          const first = inStrip ? null : anchor.closest('.session-server-row-actions')?.firstElementChild;
          const placeAt = first instanceof HTMLElement && first !== anchor ? first : anchor;
          setConfirming((c) => (c?.key === key ? c : { key, anchor, placeAt }));
        }}
        data-testid="session-server-stop">
        {inStrip && (
          <svg className={`session-server-stop-glyph${busy ? ' session-server-stop-glyph-busy' : ''}`} width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
            <rect x="0.5" y="0.5" width="8" height="8" rx="1.5" fill="currentColor" />
          </svg>
        )}
        {inStrip ? (
          // Both labels hold the space, so the button and the chips beside it never move.
          <span className="session-servers-strip-stop-label">
            <span aria-hidden={busy || undefined} className={busy ? 'session-servers-strip-stop-off' : undefined}>Stop<span className="session-servers-strip-stop-port"> :{s.port}</span></span>
            <span aria-hidden={!busy || undefined} className={busy ? undefined : 'session-servers-strip-stop-off'}>Stopping…</span>
          </span>
        ) : <span aria-live="polite">{busy ? 'Stopping…' : 'Stop'}</span>}
      </button>
    );
  };

  const popover = confirming && confirmed && (
    <StopPopover server={confirmed} anchor={confirming.anchor} placeAt={confirming.placeAt} sent={!!confirming.sent}
      onCancel={cancel} onConfirm={() => {
        if (confirming.sent) return;
        setConfirming({ ...confirming, sent: true });
        onStop(confirmed);
      }} />
  );

  if (variant === 'strip') {
    // One chip per web page, to switch between them. The page shown has its Stop at the row's
    // end, where it stays put: a chip that grew one moved the next chip under a double click.
    // Anything else (a database, a raw TCP service) is under "Servers", as is every other Stop:
    // its count is of every server, so one that is not a chip is never out of sight.
    const pages = list.filter(openable);
    const others = list.length - pages.length;
    const shown = pages.find((s) => s.port === activePort);
    const hiddenPages = pages.filter((s) => fit.hidden.includes(serverKey(s)));
    const chip = (s: SessionServer, form: ChipForm, measure: boolean) => {
      const key = serverKey(s);
      const active = activePort === s.port;
      const busy = stopping.has(key);
      return (
        <span key={`${key}-${form}`}
          className={`session-server-chip${active ? ' session-server-chip-active' : ''}${busy ? ' session-server-chip-stopping' : ''} session-server-chip-${form}`}
          {...(measure
            ? { 'data-measure': key, 'data-form': form, 'data-active': active ? '' : undefined }
            : { 'data-testid': 'session-server-chip', 'data-port': s.port, 'data-active': active || undefined })}>
          <button type="button" className="session-server-chip-open" tabIndex={measure ? -1 : undefined}
            aria-current={!measure && active ? true : undefined}
            aria-label={form !== 'full' ? `${active ? 'Showing' : 'Open'} :${s.port} ${chipName(s)}` : undefined}
            onClick={measure ? undefined : () => onOpen(s)}
            title={measure ? undefined : `${active ? 'Showing' : 'Open'} ${s.url}${s.title ? `\n${s.title}` : ''}\n${s.command}`}>
            <span className={`session-server-dot session-server-dot-${s.kind}`} aria-hidden="true" />
            <span className="session-server-port">:{s.port}</span>
            {form !== 'port' && <span className="session-server-name">{chipName(s)}</span>}
          </button>
          {!measure && stopErrors.get(key) && <span className="session-server-error" role="alert" title={stopErrors.get(key)}>Couldn't stop</span>}
        </span>
      );
    };
    return (
      <div className="session-servers-strip" data-testid="session-servers-strip" aria-label="Servers this session started">
        <button type="button" className={`session-servers-strip-all${showingAll ? ' session-servers-strip-all-open' : ''}`}
          onClick={onShowAll} aria-expanded={!!showingAll} data-testid="session-servers-show-all"
          title={`${list.length} server${list.length === 1 ? '' : 's'} this session started${hostLabel ? ` on ${hostLabel}` : ''}${others > 0 ? ` (${pages.length} web, ${others} not web)` : ''}, each with its command, uptime and pid, to open or stop`}>
          All servers{hostLabel && <span className="session-servers-strip-all-host"> on {hostLabel}</span>}
          <span className="session-servers-strip-count" data-testid="session-servers-count">{list.length}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div ref={chipsRef} className="session-servers-strip-chips"
          style={fit.cut ? { '--session-server-chip-cut': `${fit.cut}px` } as CSSProperties : undefined}>
          {pages.filter((s) => !fit.hidden.includes(serverKey(s))).map((s) =>
            chip(s, fit.form, false))}
        </div>
        {/* Out of sight: each chip drawn both ways, for the layout above. */}
        <div ref={measureRef} className="session-servers-strip-chips session-servers-measure" aria-hidden="true">
          {pages.map((s) => [chip(s, 'full', true), chip(s, 'port', true)])}
        </div>
        {hiddenPages.length > 0 && (
          <button type="button" className="session-servers-strip-others" onClick={onShowAll}
            data-testid="session-servers-others"
            title={`${hiddenPages.map((s) => `:${s.port} ${chipName(s)}`).join('\n')}\nOpen them from the list under Servers`}
            aria-label={`${hiddenPages.length} more web page${hiddenPages.length === 1 ? '' : 's'}: show the list`}>
            +{hiddenPages.length}
          </button>
        )}
        {shown && stopButton(shown, true)}
        {popover}
      </div>
    );
  }

  return (
    <div ref={listRef} className={`session-servers-list${dense ? ' session-servers-list-dense' : ''}`} data-testid="session-servers-list">
      <div className="session-servers-list-title">
        <span>{title}{hostLabel ? ` on ${hostLabel}` : ''}</span>
        {onClose && (
          <button type="button" className="session-server-btn session-server-btn-icon session-servers-list-close"
            onClick={onClose} aria-label="Close the server list" title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      <ul className="session-servers-rows">
        {list.map((s) => {
          const key = serverKey(s);
          const error = stopErrors.get(key);
          const age = formatAge(serverAge(s));
          const active = activePort === s.port;
          return (
            <li key={key}
              className={`session-server-row${active ? ' session-server-row-active' : ''}${flash && !openable(s) ? ' session-server-row-flash' : ''}`}
              data-testid="session-server-row" data-port={s.port} data-other={openable(s) ? undefined : ''}
              title={dense ? [
                [`:${s.port}`, s.title || serverLabel(s), s.via === 'terminal' && 'Terminal', !openable(s) && 'not a web page', active && 'Showing'].filter(Boolean).join(' · '),
                s.command,
                [age && `up ${age}`, bindLabel(s), `pid ${s.pid}`].filter(Boolean).join(' · '),
              ].filter(Boolean).join('\n') : undefined}>
              <div className="session-server-row-main">
                <span className={`session-server-dot session-server-dot-${s.kind}`} aria-hidden="true" />
                <span className="session-server-port">:{s.port}</span>
                {s.title
                  ? <><span className="session-server-title" title={s.title}>{s.title}</span><span className="session-server-name session-server-program">{serverLabel(s)}</span></>
                  : <span className="session-server-name">{serverLabel(s)}</span>}
                {s.via === 'terminal' && <span className="session-server-tag">Terminal</span>}
                {!openable(s) && <span className="session-server-tag">not a web page</span>}
                {active && <span className="session-server-tag session-server-tag-active">Showing</span>}
              </div>
              <div className="session-server-row-meta">
                <code className="session-server-command" title={s.command}>{shortCommand(s.command) || s.name}</code>
              </div>
              <div className="session-server-row-facts">
                {[age && `up ${age}`, bindLabel(s), `pid ${s.pid}`].filter(Boolean).join(' · ')}
                {error && <span className="session-server-error" role="alert"> · Couldn't stop: {error}</span>}
              </div>
              <div className="session-server-row-actions">
                {s.command && <CopyCommand command={s.command} />}
                {openable(s) && !active ? (
                  <button type="button" className="session-server-btn session-server-btn-open" onClick={() => onOpen(s)}
                    disabled={stopping.has(key)}
                    title={stopping.has(key) ? 'Stopping…' : `Open ${s.url} here`} aria-label={`Open the server on port ${s.port}`}
                    data-testid="session-server-open">
                    Open
                  </button>
                ) : (
                  // The Open column keeps its width, so every row's buttons line up.
                  <span className="session-server-btn-slot" aria-hidden="true" />
                )}
                {stopButton(s, false)}
              </div>
            </li>
          );
        })}
      </ul>
      {popover}
    </div>
  );
}
