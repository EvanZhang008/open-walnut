import { useEffect, useRef, useState } from 'react';

interface Props {
  active: boolean;                     // is a custom range currently the active selection
  start?: string;
  end?: string;
  bounds: { min: string | null; max: string | null };
  onApply: (start: string, end: string) => void;
}

/**
 * "Custom" date-range control that lives alongside the preset tabs. Collapsed to
 * a single button; expands to two date inputs. Applies only when both dates are
 * set and start ≤ end.
 */
export function UsageDateRange({ active, start, end, bounds, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(start ?? bounds.min ?? '');
  const [e, setE] = useState(end ?? bounds.max ?? '');
  const ref = useRef<HTMLDivElement>(null);

  // Sync local inputs when an external selection changes.
  useEffect(() => { if (start) setS(start); }, [start]);
  useEffect(() => { if (end) setE(end); }, [end]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const label = active && start && end
    ? (start === end ? start : `${start.slice(5)} – ${end.slice(5)}`)
    : 'Custom';

  const valid = s && e && s <= e;

  return (
    <div className="usage-daterange" ref={ref}>
      <button
        className={`usage-period-tab${active ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span className="usage-daterange-caret">▾</span>
      </button>
      {open && (
        <div className="usage-daterange-pop">
          <label className="usage-daterange-field">
            <span>From</span>
            <input type="date" value={s} min={bounds.min ?? undefined} max={bounds.max ?? undefined} onChange={(ev) => setS(ev.target.value)} />
          </label>
          <label className="usage-daterange-field">
            <span>To</span>
            <input type="date" value={e} min={bounds.min ?? undefined} max={bounds.max ?? undefined} onChange={(ev) => setE(ev.target.value)} />
          </label>
          <button
            className="usage-daterange-apply"
            disabled={!valid}
            onClick={() => { if (valid) { onApply(s, e); setOpen(false); } }}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
