/**
 * Engine settings popover for ONE session: the rows a running session reads,
 * a write-scope switch (the engine's own default layer, or this project only),
 * and every sentence about where a value comes from and where a save lands.
 *
 * Shape rules, each one a design decision recorded in the slice spec:
 * - A dialog, not a menu. Rows hold native <select>s whose popup produces
 * pointer events a role=menu closer would take as "outside"; this root has
 * an explicit Close and an outside closer that only reacts to a pointerdown
 * whose target is outside the root.
 * - Fixed height (min(720px, the space above the composer)), flex column, and
 * ONLY the rows area scrolls. The placement hook measures the root's
 * scrollHeight, which never changes when the inner scroller's content does,
 * so the skeleton, the dense list, a filtered list and the empty state all
 * keep the same height and the same top. Inside, the chrome is kept
 * lean: the rows get more than half of the box at 1280x800.
 * - Opening asks for the remembered scope on its FIRST request when the
 * session's cwd is known (one round trip, not two); the memory is per
 * engine + host + cwd and only ever written after that engine's view said
 * the project layer exists, so a session without a cwd never sends
 * scope=project, and a first load that still answers 400 falls back
 * to the default scope and forgets the memory.
 * - Focus returns to the "+" button only for Escape, Close and the footer
 * link. An outside pointerdown leaves focus where the user clicked,
 * after blurring the active element so an uncommitted text draft is
 * committed before the node unmounts.
 */
import {
  useCallback, useEffect, useId, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { LOCAL_HOST, type EngineSettingsWriteScope } from '@/api/engine-settings';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { findItem, sessionsGroup } from '@/hooks/engine-settings-model';
import {
  aboutScopeLine, dialogAriaLabel, hostLabel, scopeUnavailableReason, shortenCwd, splitCwdShort,
} from '@/utils/engine-settings-copy';
import { log } from '@/utils/log';
import { committedValueOf, focusInside, isTextEntry, quietFocus, visibleFocusable } from './engine-settings-popover-focus';
import {
  EngineSettingsFilterBar,
  EngineSettingsFooter,
  EngineSettingsRowsArea,
  EngineSettingsScopeNotes,
} from './EngineSettingsPopoverBody';
import { AboutButton, ScopeOptionButton } from './EngineSettingsPopoverChrome';
import { useScopedEngineSettings } from './engine-settings-scope-memory';
import '@/styles/engine-settings.css';
import '@/styles/engine-settings-popover.css';
import '@/styles/engine-settings-popover-rows.css';
import '@/styles/engine-settings-popover-footer.css';

export type EngineSettingsCloseReason = 'escape' | 'close' | 'outside' | 'link' | 'anchor-lost';

export interface EngineSettingsPopoverProps {
  sessionId: string;
  engine: string;
  /** Product label of the engine ("Claude Code", "Codex"); the view's own name is shorter. */
  displayName: string;
  host: string | undefined;
  cwd: string | undefined;
  anchorRef: RefObject<HTMLElement | null>;
  /** When set, the popover's bottom edge clears this box instead of the anchor's row (useEngineSettingsEntry decides). */
  composerRef?: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: (reason: EngineSettingsCloseReason) => void;
  /** Local host only: a file path in the Files list opens the panel's Files view. */
  onOpenPath?: (path: string) => void;
}

const DRAFT_GUARD_SENTENCE = 'Press Enter to save the value first, or Escape to discard.';
const DRAFT_GUARD_MS = 3000;

export function EngineSettingsPopover(props: EngineSettingsPopoverProps) {
  const { sessionId, engine, displayName, host, cwd, anchorRef, composerRef, open, onClose, onOpenPath } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const navigate = useNavigate();

  const [filter, setFilter] = useState('');
  const [draftGuard, setDraftGuard] = useState<string | null>(null);
  // The scope memory owns the scope and the load for it (engine-settings-scope-memory.ts).
  const { scope, pick: rememberScope, settings } = useScopedEngineSettings({ sessionId, engine, host, cwd, open });
  const { view, loading, refreshing, loadError, banner, savingKeys, lastWrite } = settings;

  /**: how the user last drove the dialog; a save that lands after a mouse action moves focus without a ring. */
  const modalityRef = useRef<'pointer' | 'keyboard'>('pointer');
  /** `exists` per file id when the popover opened: a flip to true reads "created just now". */
  const existedAtOpenRef = useRef<Map<string, boolean> | null>(null);
  /** The first visible row before a scope switch and its offset from the scroller's top; restored after the new view paints. */
  const restoreRowRef = useRef<{ key: string; offset: number } | null>(null);
  /** A guarded pointerdown still produces a click; that click must not switch the scope. */
  const suppressClickRef = useRef(false);
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback((reason: EngineSettingsCloseReason) => { onCloseRef.current(reason); }, []);
  // edgeOverflow 'clamp': from the rightmost column's "+" the 480px box
  // does not fit start-aligned; the hook's default would flip it right-aligned
  // at the anchor, over the neighbouring column. Clamping to the viewport edge
  // keeps it over the session it belongs to. The bottom edge clears the
  // composer BOX while the owner passes it (a short draft: the textarea stays
  // clickable and that click is the outside click that closes the popover and
  // lands the caret); a tall draft would squeeze the rows, so the owner
  // then withholds the box and the bottom sits on the "+" row.
  const placement = useMenuPlacement(open, anchorRef, rootRef, {
    preferSide: 'up', align: 'start', edgeOverflow: 'clamp', verticalAnchorRef: composerRef, margin: 12, minHeight: 320,
    onAnchorLost: () => close('anchor-lost'),
  });
  /** "About these settings" is an overlay over the rows: opening it moves neither the filter nor the rows. */
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutButtonRef = useRef<HTMLButtonElement>(null);
  const aboutId = useId();

  const effectiveCwd = view?.cwd ?? cwd ?? '';
  const cwdShort = effectiveCwd ? shortenCwd(effectiveCwd) : '';
  const cwdParts = splitCwdShort(cwdShort);
  const hostText = hostLabel(host);
  const saving = savingKeys.length > 0;
  const projectAvailable = view?.projectScopeAvailable ?? false;
  const switchLocked = saving || loadError?.phase === 'initial' || (!view && !loadError);
  const group = sessionsGroup(view);
  const dataState = loadError ? 'error' : !view ? 'loading' : (group?.items.length ?? 0) === 0 ? 'empty' : 'ready';

  // Reset per open (the scope itself is the memory hook's): the filter empty,
  // the file baseline taken from the first answer.
  useEffect(() => {
    if (open) return;
    setFilter('');
    setDraftGuard(null);
    setAboutOpen(false);
    existedAtOpenRef.current = null;
  }, [open]);

  useEffect(() => {
    if (view && !existedAtOpenRef.current) existedAtOpenRef.current = new Map(view.files.map((f) => [f.id, f.exists]));
  }, [view]);

  useEffect(() => {
    if (!lastWrite) return;
    log.info('settings', 'engine settings save landed from session popover', {
      sessionId, engine, key: lastWrite.key, scope: lastWrite.scope, changed: lastWrite.result.changed.join(','),
    });
  }, [lastWrite, sessionId, engine]);

  // The scroller keeps the first visible row where it was across a scope switch
  //by DELTA, so a row that started 80px above the fold stays 80px
  // above it and only the rows' own new "Saves to" lines move content.
  useEffect(() => {
    const remembered = restoreRowRef.current;
    const rows = rowsRef.current;
    if (!remembered || !rows || !view || view.scope !== scope) return;
    restoreRowRef.current = null;
    const row = rows.querySelector<HTMLElement>(`.engine-settings-popover-row[data-key="${CSS.escape(remembered.key)}"]`);
    if (!row) return;
    const offsetNow = row.getBoundingClientRect().top - rows.getBoundingClientRect().top;
    rows.scrollTop += offsetNow - remembered.offset;
  }, [view, scope]);

  const showGuard = useCallback(() => {
    setDraftGuard(DRAFT_GUARD_SENTENCE);
    if (guardTimerRef.current) clearTimeout(guardTimerRef.current);
    guardTimerRef.current = setTimeout(() => setDraftGuard(null), DRAFT_GUARD_MS);
  }, []);
  useEffect(() => () => { if (guardTimerRef.current) clearTimeout(guardTimerRef.current); }, []);

  const pickScope = useCallback((next: EngineSettingsWriteScope) => {
    if (next === scope || switchLocked) return;
    if (next === 'project' && !projectAvailable) return;
    const rows = rowsRef.current;
    restoreRowRef.current = null;
    if (rows) {
      const top = rows.getBoundingClientRect().top;
      const first = Array.from(rows.querySelectorAll<HTMLElement>('.engine-settings-popover-row'))
        .find((el) => el.getBoundingClientRect().bottom > top + 1);
      if (first?.dataset.key) restoreRowRef.current = { key: first.dataset.key, offset: first.getBoundingClientRect().top - top };
    }
    settings.clearLastWrite();
    rememberScope(next);
    log.info('settings', 'engine settings popover scope switched', { sessionId, engine, scope: next });
  }, [scope, switchLocked, projectAvailable, settings, rememberScope, sessionId, engine]);

  /**: a text draft the user has not committed must not be swept into the old scope by the blur a click causes. */
  const onScopePointerDown = useCallback((e: ReactPointerEvent) => {
    suppressClickRef.current = false;
    const active = document.activeElement;
    if (!isTextEntry(active) || !rootRef.current?.contains(active)) return;
    const committed = committedValueOf(active, (key) => findItem(view, key)?.value);
    if (committed === undefined || active.value === committed) return;
    e.preventDefault();
    suppressClickRef.current = true;
    showGuard();
  }, [view, showGuard]);

  const onScopeClick = useCallback((next: EngineSettingsWriteScope) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    pickScope(next);
  }, [pickScope]);

  const onScopeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: EngineSettingsWriteScope = scope === 'default' ? 'project' : 'default';
    pickScope(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
  }, [scope, pickScope]);

  const placed = placement !== null;
  // Focus lands on the dialog itself so a screen reader announces its name.
  useEffect(() => {
    if (open && placement) rootRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  // Outside closer: capture-phase pointerdown anywhere outside the root. The
  // anchor is NOT exempt: a press on "+" closes this and the click that
  // follows opens the menu, one state flip each.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      requestAnimationFrame(() => close('outside'));
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  const returnFocusAndClose = useCallback((reason: EngineSettingsCloseReason) => {
    const anchor = anchorRef.current;
    close(reason);
    anchor?.focus({ preventScroll: true });
  }, [anchorRef, close]);

  // A saving row disables its <fieldset>; Chromium then drops focus to
  // <body> with no event, and a key pressed there never reaches the root's own
  // handler. Two answers. (a) Keys pressed while focus is outside the dialog are
  // handled at the document: Escape closes, Tab re-enters the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || focusInside(root)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (aboutOpen) { setAboutOpen(false); aboutButtonRef.current?.focus(); return; }
        returnFocusAndClose('escape');
      } else if (e.key === 'Tab') {
        const stops = visibleFocusable(root);
        if (stops.length === 0) return;
        e.preventDefault();
        (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, aboutOpen, returnFocusAndClose]);

  // (b) When a save finishes and focus is not on a control, put it on that row's
  // control. "Not on a control" includes the dialog ROOT: WebKit does
  // not focus a button on click, so after a mouse toggle the root, focused at
  // open, is still the active element and a keyboard user would Tab from the top.
  // (c) The footer may have grown with that answer (a three-line saved sentence,
  // a failed save's banner) and the rows area shrinks from the bottom: the row
  // the user just acted on is scrolled back into view so its control never
  // disappears under the status slot.
  // (d) After a mouse action the focus move is silent: the control gets
  // a class that hides its ring until the keyboard is used or it blurs.
  const prevSavingRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const finished = prevSavingRef.current.filter((k) => !savingKeys.includes(k));
    prevSavingRef.current = savingKeys;
    const root = rootRef.current;
    if (!open || finished.length === 0 || !root) return;
    const key = finished[finished.length - 1];
    const row = rowsRef.current?.querySelector<HTMLElement>(`.engine-settings-popover-row[data-key="${CSS.escape(key)}"]`);
    if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    const active = document.activeElement;
    if (active && active !== root && active !== document.body && root.contains(active)) return;
    const control = row
      ? visibleFocusable(row)[0] ?? row.querySelector<HTMLElement>('[role="switch"], select, input, button') ?? undefined
      : undefined;
    if (control && modalityRef.current === 'pointer') quietFocus(control);
    (control ?? root).focus({ preventScroll: true });
  }, [savingKeys, open]);

  const onRootKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      // A row input preventDefaults every Escape, whether or not it had a draft
      // to discard. Only a real discard uses the key: the input's value
      // still differs from the committed one here, since the row's reset paints
      // on the next render. A clean input's Escape is a close request.
      if (e.defaultPrevented && target.matches('input, select, textarea')) {
        // The "Custom…" input of a select closes itself on Escape; that is its own step.
        if (!isTextEntry(target) || target.classList.contains('engine-setting-custom')) return;
        const committed = committedValueOf(target, (key) => findItem(view, key)?.value);
        if (committed === undefined || target.value !== committed) return;
      }
      e.preventDefault();
      // The About overlay is the topmost layer: Escape closes it first.
      if (aboutOpen) { setAboutOpen(false); aboutButtonRef.current?.focus(); return; }
      // A focused native select: the same key closes its popup when one is open
      // (that Escape never reaches the page), so without a popup it only steps
      // out of the control; the popover closes on the next one.
      if (target instanceof HTMLSelectElement) { target.blur(); rootRef.current?.focus({ preventScroll: true }); return; }
      if (target === filterRef.current && filter) { setFilter(''); return; }
      returnFocusAndClose('escape');
      return;
    }
    if (e.key !== 'Tab' || !rootRef.current) return;
    const focusable = visibleFocusable(rootRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }, [filter, aboutOpen, returnFocusAndClose, view]);

  // Opening a settings file in the panel's Files view is leaving the popover.
  const onOpenFilePath = useCallback((path: string) => {
    onOpenPath?.(path);
    close('link');
  }, [onOpenPath, close]);

  const onFooterLink = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const anchor = anchorRef.current;
    close('link');
    anchor?.focus({ preventScroll: true });
    navigate('/settings#engines');
  }, [anchorRef, close, navigate]);

  if (!open) return null;
  const projectLockedReason = view && !projectAvailable ? scopeUnavailableReason({ cwd: view.cwd, displayName }) : null;
  const scopeTitle = saving ? 'Wait for the current save to finish' : undefined;
  // One Tab stop for the radiogroup (the checked option); arrows move
  // between the options (onScopeKeyDown). an unavailable side wears a
  // lock glyph and its reason as the tooltip, so it reads as "cannot be picked"
  // before a click, not as "merely unselected".
  const scopeOption = (value: EngineSettingsWriteScope, label: string) => {
    const unavailable = value === 'project' && !!view && !projectAvailable;
    return (
      <ScopeOptionButton
        value={value}
        label={label}
        checked={scope === value}
        disabled={switchLocked || unavailable}
        unavailable={unavailable}
        reasonId={reasonId}
        title={unavailable ? projectLockedReason ?? undefined : scopeTitle}
        onPointerDown={onScopePointerDown}
        onClick={() => onScopeClick(value)}
      />
    );
  };

  return createPortal(
    <div
      ref={rootRef}
      className="engine-settings-popover"
      role="dialog"
      tabIndex={-1}
      data-testid="engine-settings-popover"
      data-scope={scope}
      data-state={dataState}
      aria-label={dialogAriaLabel(displayName, cwdShort, hostText, view?.appliesOn)}
      aria-busy={loading || undefined}
      onPointerDownCapture={() => { modalityRef.current = 'pointer'; }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDownCapture={() => { modalityRef.current = 'keyboard'; }}
      onKeyDown={onRootKeyDown}
      style={{
        top: placement?.top,
        right: placement?.right,
        visibility: placement ? undefined : 'hidden',
        ['--menu-max-height' as string]: placement ? `${placement.maxHeight}px` : undefined,
      } as CSSProperties}
    >
      <header className="engine-settings-popover-header">
        <div className="engine-settings-popover-heading">
          <h2 className="engine-settings-popover-title">{displayName} settings</h2>
          {/* The subtitle has the whole width, and the last segment (the
              repo) never shrinks: the head is what the ellipsis eats. */}
          <div className="engine-settings-popover-subtitle" title={effectiveCwd || undefined}>
            <span className="engine-settings-subtitle-head">{hostText}{cwdShort ? ` · ${cwdParts.head}` : ''}</span>
            {cwdShort && <span className="engine-settings-subtitle-tail">{cwdParts.tail}</span>}
          </div>
        </div>
      </header>
      {/* The engine's note (view.note) plus the group's help as an overlay
          over the rows, never in the flow: the filter and the rows keep their
          place when it opens. Its first line names the file the switch's
          current position writes, so the note cannot contradict it. */}
      {aboutOpen && view && (
        <div className="engine-settings-about-panel" id={aboutId} role="region" aria-label="About these settings">
          <p className="engine-settings-about-scope" data-testid="engine-settings-about-scope">
            {aboutScopeLine(scope, displayName, hostText, cwdShort, view.files, view.cwd)}
          </p>
          {group?.help && <p className="engine-settings-group-help">{group.help}</p>}
          {view.note && <p className="engine-settings-about-body">{view.note}</p>}
          <button type="button" className="engine-settings-about-close" onClick={() => { setAboutOpen(false); aboutButtonRef.current?.focus(); }}>
            Done
          </button>
        </div>
      )}
      <div className="engine-settings-popover-scope-block">
        <div className="engine-settings-scope-row">
          <span className="engine-settings-scope-label" aria-hidden>Save changes to</span>
          <div
            className="engine-settings-scope"
            role="radiogroup"
            aria-label="Save changes to"
            aria-disabled={switchLocked || undefined}
            onKeyDown={onScopeKeyDown}
          >
            {scopeOption('default', `Same as ${displayName}`)}
            {scopeOption('project', 'This project only')}
          </div>
        </div>
        {projectLockedReason && <p className="engine-settings-scope-reason" id={reasonId}>{projectLockedReason}</p>}
        <EngineSettingsScopeNotes
          view={view}
          scope={scope}
          displayName={displayName}
          hostText={hostText}
          cwdShort={cwdShort}
          draftGuard={draftGuard}
        />
      </div>
      <EngineSettingsFilterBar inputRef={filterRef} value={filter} onChange={setFilter} disabled={dataState !== 'ready'} />
      <EngineSettingsRowsArea
        rowsRef={rowsRef}
        settings={settings}
        engine={engine}
        displayName={displayName}
        hostText={hostText}
        scope={scope}
        filter={filter}
        busy={refreshing}
        onLink={onFooterLink}
      />
      <EngineSettingsFooter
        view={view}
        lastWrite={lastWrite}
        banner={banner}
        onDismissBanner={settings.dismissBanner}
        scope={scope}
        hostText={hostText}
        cwdShort={cwdShort}
        isLocalHost={!host || host === LOCAL_HOST}
        existedAtOpen={existedAtOpenRef.current}
        onLink={onFooterLink}
        onOpenPath={onOpenPath ? onOpenFilePath : undefined}
      />
      {/* Last in DOM order, both drawn in the header corner: Tab runs switch ->
          filter -> rows -> footer -> About (i) -> Close and wraps back to the
          switch. The (i) is in the DOM from the first frame,
          disabled until the view's note exists, so the header keeps its shape
          while loading. */}
      <AboutButton
        ref={aboutButtonRef}
        expanded={aboutOpen}
        controlsId={aboutOpen ? aboutId : undefined}
        disabled={!view}
        onToggle={() => setAboutOpen((v) => !v)}
      />
      <button type="button" className="engine-settings-popover-close" aria-label="Close" onClick={() => returnFocusAndClose('close')}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}
