// Controls stay mounted so the add menu can activate their existing handlers and popovers.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { pickVisibleControls, type ControlFitInput } from './composer-controls-fit';
import '@/styles/composer-controls.css';

export interface ComposerControl {
  /** Stable id, also the measurement key. */
  id: string;
  /** What this control IS, for its overflow row ("Reply style", "Model"). A pill
   *  reads by position on the row; a menu row has to name itself. Static on
   *  purpose: the STATE next to it is read from the live pill, so there is no
   *  second copy of "Rich"/"MD" or of the model name to keep in sync. */
  name: string;
  /** 1 leaves the row last. */
  priority: number;
  /** Clicking this control opens a surface anchored to it, so the overflow row
   *  pins it onto the row before clicking (model picker, side-thread drawer). */
  anchored?: boolean;
  inAddMenu?: boolean;
  /** Falsy renders nothing and takes no width (a pill the session hides). */
  node: ReactNode;
}

export interface ComposerControlsBarHandle {
  activate: (id: string) => void;
  state: (id: string) => string;
}

interface ComposerControlsBarProps {
  controls: ComposerControl[];
  /** Extra classes for the row (callers keep `.session-mode-bar` styling). */
  className?: string;
  /** Lets the add menu activate the mounted control without duplicating its logic. */
  handleRef?: RefObject<ComposerControlsBarHandle | null>;
}

/** Gap between pills — mirrors `.session-mode-bar { gap: 4px }`. */
const ROW_GAP = 4;

export function ComposerControlsBar({ controls, className, handleRef }: ComposerControlsBarProps) {
  const present = useMemo(() => controls.filter((c) => !!c.node), [controls]);
  const inline = useMemo(() => present.filter((c) => !c.inAddMenu), [present]);
  const ids = useMemo(() => present.map((c) => c.id).join('|'), [present]);
  const barRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Last measured natural width per control id; hidden ones keep their last. */
  const widths = useRef(new Map<string, number>());
  const [overflow, setOverflow] = useState<string[]>([]);
  const [condensed, setCondensed] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const placement = useMenuPlacement(open, buttonRef, menuRef, {
    align: 'right', preferSide: 'up', minHeight: 120,
    onAnchorLost: () => setOpen(false),
  });

  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    for (const el of bar.querySelectorAll<HTMLElement>('[data-control-id]')) {
      const id = el.dataset.controlId!;
      const w = el.getBoundingClientRect().width;
      if (w > 0 && !condensed) widths.current.set(id, w);
    }
    const spacer = bar.parentElement?.querySelector<HTMLElement>('.chat-input-controls-spacer');
    const available = bar.getBoundingClientRect().width + (spacer?.getBoundingClientRect().width ?? 0);
    const naturalWidth = inline.reduce((total, control) => total + (widths.current.get(control.id) ?? 64), 0)
      + Math.max(0, inline.length - 1) * ROW_GAP;
    const compact = available < Math.max(220, naturalWidth);
    setCondensed((prev) => prev === compact ? prev : compact);
    const buttonWidth = buttonRef.current?.getBoundingClientRect().width || 22;
    const input: ControlFitInput[] = inline.map((c) => ({
      id: c.id,
      priority: pinned === c.id ? 0 : c.priority,
      width: compact && c.id === 'mode' && bar.querySelector('[data-control-id="mode"] .mode-toggle-pill-shortcut')
        ? Math.max(40, (widths.current.get(c.id) ?? 80) - 28)
        : compact && c.id === 'model'
          ? 50
          : widths.current.get(c.id),
    }));
    const next = pickVisibleControls(input, available, { gap: ROW_GAP, overflowButtonWidth: buttonWidth });
    setOverflow((prev) => (prev.length === next.overflow.length && prev.every((id, i) => id === next.overflow[i])
      ? prev : next.overflow));
    // Everything fits again: drop the pin, so a column that grew goes back to
    // the plain priority order instead of remembering one menu click forever.
    if (next.overflow.length === 0) setPinned((p) => (p === null ? p : null));
  }, [inline, pinned, condensed]);

  useLayoutEffect(() => {
    measure();
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    // The row only shrinks when the space around it does, and its own box stops
    // changing once it has collapsed — watch the whole controls row too.
    if (bar.parentElement) ro.observe(bar.parentElement);
    for (const el of bar.querySelectorAll<HTMLElement>('[data-control-id]')) ro.observe(el);
    return () => ro.disconnect();
    // `ids` covers "a control appeared or disappeared"; `measure` covers the rest.
  }, [measure, ids]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (buttonRef.current?.contains(t as Node) || menuRef.current?.contains(t as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The control you last touched stays on the row (priority 0) until the column
  // grows enough for everything or you touch another one. Two things need it: a
  // picker portalled to <body> anchors to its pill, so hiding that pill during a
  // resize would leave the picker pointing at a zero rect; and a control you just
  // used is the one you are most likely to use again.
  const pinTouched = useCallback((e: React.PointerEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-control-id]') as HTMLElement | null;
    const id = el?.dataset.controlId;
    if (id) setPinned((p) => (p === id ? p : id));
  }, []);

  const activate = useCallback((control: ComposerControl) => {
    const click = () => {
      const el = barRef.current?.querySelector<HTMLElement>(`[data-control-id="${control.id}"]`);
      (el?.querySelector<HTMLElement>('button, [role="button"]') ?? el)?.click();
    };
    if (control.inAddMenu) { click(); return; }
    if (!control.anchored) { click(); return; }
    setPinned(control.id);
    setOpen(false);
    requestAnimationFrame(() => requestAnimationFrame(click));
  }, []);

  useImperativeHandle(handleRef, () => ({
    activate: (id) => {
      const control = present.find((c) => c.id === id);
      if (control) activate(control);
    },
    state: (id) => {
      const button = barRef.current?.querySelector<HTMLElement>(`[data-control-id="${id}"] button`);
      const ariaLabel = button?.getAttribute('aria-label');
      return id === 'output' ? ariaLabel?.replace(/^Output mode: /, '') ?? '' : ariaLabel ?? button?.textContent?.trim() ?? '';
    },
  }), [present, activate]);

  const hidden = new Set(overflow);
  return (
    <>
      <div
        ref={barRef}
        className={`composer-controls-bar${className ? ` ${className}` : ''}${condensed ? ' is-condensed' : ''}`}
        onPointerDownCapture={pinTouched}
      >
        {present.map((c) => (
          <span
            key={c.id}
            className="composer-control"
            data-control-id={c.id}
            data-hidden={hidden.has(c.id) || c.inAddMenu ? 'true' : 'false'}
            data-add-menu={c.inAddMenu ? 'true' : undefined}
          >
            {c.node}
          </span>
        ))}
        {overflow.length > 0 && (
          <button
            ref={buttonRef}
            type="button"
            className={`composer-overflow-btn${open ? ' is-open' : ''}`}
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`More controls (${overflow.length})`}
            title="More controls"
            data-testid="composer-overflow-btn"
          >
            <span aria-hidden="true">···</span>
          </button>
        )}
      </div>
      {open && createPortal(
        <div
          ref={menuRef}
          className="composer-overflow-menu"
          role="menu"
          style={menuPlacementStyle(placement)}
          // Portals escape clipping, not bubbling: without this the composer's
          // own drag/pointer handlers see these clicks.
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="composer-overflow-menu"
        >
          {overflow.map((id) => {
            const control = present.find((c) => c.id === id);
            if (!control) return null;
            return <OverflowRow key={id} control={control} barRef={barRef} onActivate={activate} />;
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * One menu row: the control's name, plus whatever its hidden pill currently
 * says. The state half is read from the DOM on open (and whenever the pill's
 * text changes) so the row cannot drift from the control: no second copy of
 * "Rich"/"MD", of the model name, or of the context percentage to keep in sync.
 */
function OverflowRow({ control, barRef, onActivate }: {
  control: ComposerControl;
  barRef: React.RefObject<HTMLDivElement | null>;
  onActivate: (control: ComposerControl) => void;
}) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>(`[data-control-id="${control.id}"]`);
    if (!el) return;
    const read = () => setLabel((el.textContent ?? '').replace(/\s+/g, ' ').trim());
    read();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(el, { subtree: true, characterData: true, childList: true });
    return () => mo.disconnect();
  }, [barRef, control.id]);
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const value = label && norm(label) !== norm(control.name) ? label : '';
  return (
    <button
      type="button"
      className="composer-overflow-item"
      role="menuitem"
      onClick={() => onActivate(control)}
      data-testid={`composer-overflow-item-${control.id}`}
    >
      <span className="composer-overflow-item-name">{control.name}</span>
      {value && <span className="composer-overflow-item-value">{value}</span>}
    </button>
  );
}
