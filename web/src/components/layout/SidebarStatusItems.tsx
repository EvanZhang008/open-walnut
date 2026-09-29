/**
 * Plugin status items in the rail, above Voice: a small ring per item that ticks on its
 * own, and a popover with the item's buttons (Rhythm's stand-up countdown is the first).
 *
 * The ring shows minutes left (or a glyph); the expanded rail adds the title. Clicking
 * opens a portalled popover beside the rail, placed by useMenuPlacement like every other
 * overlay. A button closes the popover AT ONCE and runs the plugin's own op through the
 * plugin-runtime route; the item shows it is working (a pulsing ring, "Start break…")
 * until the op answers, and the new state arrives as the next `plugin:status-items`. The
 * op takes tens of milliseconds, but a server busy with other work once held one for 5s,
 * and a popover waiting on it read as a broken button. A failure reopens the popover with
 * the reason (or, when the item is gone, says so in an error toast).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppCatalog } from '@/apps/hooks';
import { useNotifications } from '@/contexts/notifications';
import { runOpAction } from '@/contexts/notifications/notification-actions';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import {
  itemTitle, orderedActions, ringFraction, ringText,
  type StatusItem, type StatusItemAction, type StatusItemGlyph,
} from './status-item-model';
import { useStatusItems, useTicker } from './useStatusItems';
import '@/styles/sidebar-status-items.css';

const TICK_MS = 5_000;
const R = 9.4;
const CIRCUMFERENCE = 2 * Math.PI * R;

function Glyph({ glyph }: { glyph: StatusItemGlyph }) {
  if (glyph === 'stand') {
    return (
      <g className="status-ring-glyph">
        <circle cx="11" cy="6.9" r="1.35" className="status-ring-glyph-fill" />
        <path d="M11 9.2v3.6M8.9 10.6h4.2M11 12.8l-1.5 3M11 12.8l1.5 3" />
      </g>
    );
  }
  if (glyph === 'check') return <path className="status-ring-glyph" d="m7.6 11.2 2.3 2.3 4.5-4.6" />;
  if (glyph === 'pause') return <path className="status-ring-glyph" d="M9.4 8.2v5.6M12.6 8.2v5.6" />;
  return <path className="status-ring-glyph" d="M11 7.4v4.4M11 14.5v.1" />;
}

export function StatusRing({ item, now, className = 'status-ring' }: { item: StatusItem; now: number; className?: string }) {
  const frac = ringFraction(item, now);
  const text = ringText(item, now);
  // A sliver, not nothing, at 0: a ring that vanishes reads as "broken", not "ending".
  const offset = CIRCUMFERENCE * (1 - Math.max(0.001, Math.min(1, frac)));
  return (
    <svg className={className} viewBox="0 0 22 22" aria-hidden="true">
      <circle className="status-ring-track" cx="11" cy="11" r={R} />
      <circle
        className="status-ring-arc"
        cx="11" cy="11" r={R}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 11 11)"
      />
      {item.glyph ? <Glyph glyph={item.glyph} /> : text ? <text x="11" y="14.1" textAnchor="middle">{text}</text> : null}
    </svg>
  );
}

interface Pending { op: string; label: string; seq: number }

export function SidebarStatusItems({ collapsed }: { collapsed: boolean }) {
  const items = useStatusItems();
  useTicker(items.some((item) => item.timer), TICK_MS);
  const now = Date.now();
  const { notify } = useNotifications();
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Set when a failed op reopens its popover; cleared by the next open or run.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  // Per item: two items' ops can run at once, and each shows its own until it answers.
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const pendingSeq = useRef(0);
  // The open item's button (the popover's anchor), and every item's, so a failure can reopen at its own item.
  const openTrigger = useRef<HTMLButtonElement | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // The item went away (the plugin cleared it or was disabled): its popover goes too.
  useEffect(() => {
    if (openKey && !items.some((item) => item.key === openKey)) setOpenKey(null);
  }, [items, openKey]);

  const run = useCallback(async (item: StatusItem, action: StatusItemAction) => {
    const seq = ++pendingSeq.current;
    setPending((all) => ({ ...all, [item.key]: { op: action.op, label: action.label, seq } }));
    setFailure(null);
    setOpenKey(null);
    const result = await runOpAction(action);
    setPending((all) => {
      if (all[item.key]?.seq !== seq) return all;
      const { [item.key]: _done, ...rest } = all;
      return rest;
    });
    if (result.ok) return;
    log.warn('status-items', 'status item action failed', { key: item.key, op: action.op, message: result.message });
    const trigger = triggers.current.get(item.key);
    if (trigger && itemsRef.current.some((one) => one.key === item.key)) {
      openTrigger.current = trigger;
      setFailure({ key: item.key, message: result.message });
      setOpenKey(item.key);
      return;
    }
    notify({
      kind: 'operation-error', severity: 'error', persistent: false,
      title: `"${action.label}" did not run`, body: result.message,
      dedupKey: `status-item-action-error:${item.key}`,
    });
  }, [notify]);

  if (items.length === 0) return null;
  const open = openKey ? items.find((item) => item.key === openKey) ?? null : null;

  return (
    <>
      {items.map((item) => {
        const busy = pending[item.key] ?? null;
        const title = busy ? `${busy.label}…` : itemTitle(item, now);
        const isOpen = item.key === openKey;
        return (
          <button
            key={item.key}
            ref={(el) => { if (el) triggers.current.set(item.key, el); else triggers.current.delete(item.key); }}
            className={`sidebar-link sidebar-status-item${isOpen ? ' is-open' : ''}${busy ? ' is-pending' : ''}`}
            data-tone={item.tone}
            data-status-key={item.key}
            onClick={(e) => {
              openTrigger.current = e.currentTarget;
              setFailure(null);
              setOpenKey(isOpen ? null : item.key);
            }}
            title={collapsed ? title : undefined}
            aria-label={title}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-busy={busy ? true : undefined}
          >
            <StatusRing item={item} now={now} />
            <span className="sidebar-label">{title}</span>
          </button>
        );
      })}
      {open && (
        <StatusItemPopover
          key={open.key}
          item={open}
          now={now}
          triggerRef={openTrigger}
          busyOp={pending[open.key]?.op ?? null}
          error={failure?.key === open.key ? failure.message : null}
          // A failure reopens it without taking focus from whatever the person moved on to.
          takeFocus={failure?.key !== open.key}
          onRun={(action) => { void run(open, action); }}
          onClose={() => { setOpenKey(null); setFailure(null); }}
        />
      )}
    </>
  );
}

function StatusItemPopover({ item, now, triggerRef, busyOp, error, takeFocus, onRun, onClose }: {
  item: StatusItem;
  now: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** An op of this item is still running (the buttons wait for it). */
  busyOp: string | null;
  error: string | null;
  takeFocus: boolean;
  onRun: (action: StatusItemAction) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const catalog = useAppCatalog();
  const focusOnOpen = useRef(takeFocus);
  // Beside the rail, bottom edge level with the item: a point just right of the
  // trigger's bottom corner, opening rightward and upward. Measured once per open.
  const [anchor] = useState(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    return rect ? { x: rect.right + 10, y: rect.bottom } : null;
  });
  const placement = useMenuPlacement(true, triggerRef, popRef, {
    anchorPoint: anchor, align: 'left', preferSide: 'up', gap: 0, minHeight: 120, onAnchorLost: onClose,
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus moves in, so Tab reaches the buttons even though the portal sits at the end of <body>.
  useEffect(() => { if (focusOnOpen.current) popRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const close = () => closeRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || popRef.current?.contains(target)) return;
      // The trigger toggles on its own click; closing here too would reopen it.
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', close);
    };
  }, [triggerRef]);

  const app = item.app
    ? catalog.findByRouteId(`${item.pluginId}~${item.app}`)
    : catalog.all.find((one) => one.pluginId === item.pluginId);

  const title = itemTitle(item, now);
  return createPortal(
    <div
      ref={popRef}
      className="status-item-popover"
      data-tone={item.tone}
      data-status-key={item.key}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={menuPlacementStyle(placement)}
      // Portals bubble React events through the tree: keep the rail's handlers out of it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="status-item-popover-head">
        <StatusRing item={item} now={now} className="status-ring status-ring-lg" />
        <div className="status-item-popover-text">
          <div className="status-item-popover-title">{title}</div>
          {item.detail && <div className="status-item-popover-detail">{item.detail}</div>}
        </div>
      </div>
      {item.actions.length > 0 && (
        <div className="status-item-popover-actions">
          {orderedActions(item).map((action) => (
            <button
              key={`${action.op}:${action.label}`}
              type="button"
              className={`status-item-btn${action.primary ? ' is-primary' : ''}`}
              disabled={busyOp !== null}
              aria-busy={busyOp === action.op || undefined}
              onClick={() => onRun(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="status-item-popover-error" role="alert">{error}</div>}
      <div className="status-item-popover-foot">
        <span>{item.pluginName}</span>
        {app && (
          <button type="button" className="status-item-link" onClick={() => { onClose(); navigate(app.path); }}>
            Open {item.pluginName}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
