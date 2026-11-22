import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { Chip } from '@/components/controls';

interface Props {
  active: boolean;                     // is a custom range currently the active selection
  start?: string;
  end?: string;
  bounds: { min: string | null; max: string | null };
  onApply: (start: string, end: string) => void;
}

/**
 * "Custom" date-range control that lives alongside the preset periods. Collapsed to
 * a single chip (on while a custom range is the period); opens a popover with two
 * date inputs. Applies only when both dates are set and start <= end.
 *
 * The popover is portalled to <body> and placed by useMenuPlacement, so the
 * settings card (overflow hidden) or the window edge never cuts it off.
 */
export function UsageDateRange({ active, start, end, bounds, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(start ?? bounds.min ?? '');
  const [e, setE] = useState(end ?? bounds.max ?? '');
  // The wrapper holds only the trigger, so it is the popover's anchor too.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const placement = useMenuPlacement(open, wrapperRef, popRef, { onAnchorLost: close });

  // Sync local inputs when an external selection changes.
  useEffect(() => { if (start) setS(start); }, [start]);
  useEffect(() => { if (end) setE(end); }, [end]);

  // Close on a press outside both the trigger and the popover, on Escape, and
  // when the trigger scrolls out of view (a scroll inside the popover is not one).
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (wrapperRef.current?.contains(target) || popRef.current?.contains(target)) return;
      close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.isComposing) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      close();
    };
    const onScroll = (ev: Event) => {
      if (popRef.current?.contains(ev.target as Node)) return;
      const r = wrapperRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) close();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const label = active && start && end
    ? (start === end ? start : `${start.slice(5)} to ${end.slice(5)}`)
    : 'Custom';

  const valid = s && e && s <= e;

  return (
    <div className="usage-daterange" ref={wrapperRef}>
      <Chip
        pressed={active}
        trailing={(
          <svg className="usage-daterange-caret" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
            <polyline points="3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        data-testid="usage-period-custom"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // The bounds arrive after the first render: an empty field takes them when it opens.
          if (!open) { setS((v) => v || start || bounds.min || ''); setE((v) => v || end || bounds.max || ''); }
          setOpen((o) => !o);
        }}
      >
        {label}
      </Chip>
      {open && createPortal(
        <div
          ref={popRef}
          className="usage-daterange-pop"
          role="dialog"
          aria-label="Custom period"
          data-testid="usage-daterange-pop"
          style={menuPlacementStyle(placement)}
          // Portals escape clipping, not React event bubbling.
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          <label className="usage-daterange-field">
            <span>From</span>
            <input type="date" value={s} min={bounds.min ?? undefined} max={bounds.max ?? undefined} onChange={(ev) => setS(ev.target.value)} />
          </label>
          <label className="usage-daterange-field">
            <span>To</span>
            <input type="date" value={e} min={bounds.min ?? undefined} max={bounds.max ?? undefined} onChange={(ev) => setE(ev.target.value)} />
          </label>
          <button
            type="button"
            className="usage-daterange-apply"
            disabled={!valid}
            onClick={() => { if (valid) { onApply(s, e); close(); } }}
          >
            Apply
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
