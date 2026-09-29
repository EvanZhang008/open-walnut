/**
 * Plugin status items in the rail, above Voice: a small ring per item that ticks on its
 * own, and a popover with the item's buttons (Rhythm's stand-up countdown is the first).
 *
 * The ring shows minutes left (or a glyph); the expanded rail adds the title. Clicking
 * opens a portalled popover beside the rail, placed by useMenuPlacement like every other
 * overlay. A button runs the plugin's own op through the plugin-runtime route and the
 * popover closes on success; the new state arrives as the next `plugin:status-items`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppCatalog } from '@/apps/hooks';
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

export function SidebarStatusItems({ collapsed }: { collapsed: boolean }) {
  const items = useStatusItems();
  useTicker(items.some((item) => item.timer), TICK_MS);
  const now = Date.now();
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The open item's button, set on the click that opened it (one stable ref per rail).
  const openTrigger = useRef<HTMLButtonElement | null>(null);

  // The item went away (the plugin cleared it or was disabled): its popover goes too.
  useEffect(() => {
    if (openKey && !items.some((item) => item.key === openKey)) setOpenKey(null);
  }, [items, openKey]);

  if (items.length === 0) return null;
  const open = openKey ? items.find((item) => item.key === openKey) ?? null : null;

  return (
    <>
      {items.map((item) => {
        const title = itemTitle(item, now);
        const isOpen = item.key === openKey;
        return (
          <button
            key={item.key}
            className={`sidebar-link sidebar-status-item${isOpen ? ' is-open' : ''}`}
            data-tone={item.tone}
            data-status-key={item.key}
            onClick={(e) => { openTrigger.current = e.currentTarget; setOpenKey(isOpen ? null : item.key); }}
            title={collapsed ? title : undefined}
            aria-label={title}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
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
          onClose={() => setOpenKey(null)}
        />
      )}
    </>
  );
}

function StatusItemPopover({ item, now, triggerRef, onClose }: {
  item: StatusItem;
  now: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const catalog = useAppCatalog();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => { popRef.current?.focus({ preventScroll: true }); }, []);

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

  const run = useCallback(async (action: StatusItemAction) => {
    setBusy(action.op);
    setError(null);
    const result = await runOpAction(action);
    setBusy(null);
    if (result.ok) { closeRef.current(); return; }
    log.warn('status-items', 'status item action failed', { key: item.key, op: action.op, message: result.message });
    setError(result.message);
  }, [item.key]);

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
              disabled={busy !== null}
              aria-busy={busy === action.op || undefined}
              onClick={() => { void run(action); }}
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
