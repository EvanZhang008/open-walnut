/**
 * The kanban's toasts (spec 8.1, G7, G14): one per move, complete or failure,
 * the newest on top, three in sight and the older ones folded into
 * `+N more moves` (a button that unfolds them). Every toast keeps its own
 * buttons and its own 8s clock; the pointer over the stack pauses every clock,
 * so a toast never slides away from under the button being reached for. A
 * button runs its action and closes its toast. The queue rules are pure, in
 * kanban-toasts.ts; this file runs the one timeout they name.
 */
import '@/styles/board-kanban-controls.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ICON_CLOSE } from '@/components/common/Icons';
import { log } from '@/utils/log';
import type { KanbanToast, KanbanToastAction, KanbanToastsProps, UseKanbanToasts } from './kanban-contract';
import {
  KANBAN_PANE_SELECTOR, KANBAN_TOAST_EVENT, dismissToastItem, expiredToasts, foldToasts, nextDeadline, pauseClocks, pushToastItem, resumeClocks, syncClocks,
  type KanbanToastItem, type ToastClocks,
} from './kanban-toasts';

let toastSeq = 0;

/** The queue P3's container owns: push from any write, render with <KanbanToasts>. */
export const useKanbanToasts: UseKanbanToasts = () => {
  const [list, setList] = useState<KanbanToastItem[]>([]);
  const push = useCallback((t: KanbanToast): string => {
    const id = t.id || `kt-${Date.now().toString(36)}-${++toastSeq}`;
    setList((prev) => pushToastItem(prev, { ...t, id }));
    if (t.tone === 'error') log.warn('board', 'kanban toast', { toastId: id, text: t.text });
    return id;
  }, []);
  const dismiss = useCallback((id: string) => setList((prev) => dismissToastItem(prev, id)), []);
  return useMemo(() => ({ push, dismiss, list }), [push, dismiss, list]);
};

export function KanbanToasts({ toasts: fromProps, onDismiss: dismissProp }: KanbanToastsProps) {
  const [expanded, setExpanded] = useState(false);
  // Toasts raised inside this pane by parts with no toast API (emitKanbanToast).
  const [local, setLocal] = useState<KanbanToastItem[]>([]);
  const anchorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const pane = anchorRef.current?.closest(KANBAN_PANE_SELECTOR) ?? document;
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<KanbanToast>).detail;
      if (!t?.text) return;
      setLocal((prev) => pushToastItem(prev, { ...t, id: t.id || `kl-${Date.now().toString(36)}-${++toastSeq}` }));
    };
    pane.addEventListener(KANBAN_TOAST_EVENT, onToast);
    return () => pane.removeEventListener(KANBAN_TOAST_EVENT, onToast);
  }, []);
  const toasts = useMemo(() => (local.length ? [...local, ...fromProps] : fromProps), [local, fromProps]);
  const onDismiss = useCallback((id: string) => {
    if (local.some((t) => t.id === id)) setLocal((prev) => dismissToastItem(prev, id));
    else dismissProp(id);
  }, [local, dismissProp]);
  const [clocks, setClocks] = useState<ToastClocks>({});
  const hovered = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // A new toast starts its clock; a gone one drops it.
  useEffect(() => {
    setClocks((prev) => syncClocks(prev, toasts, Date.now(), hovered.current));
    if (toasts.length <= 3) setExpanded(false);
  }, [toasts]);

  // The one timeout: the earliest running deadline.
  useEffect(() => {
    const at = nextDeadline(clocks);
    if (at === null) return;
    const timer = setTimeout(() => {
      for (const id of expiredToasts(clocks, Date.now())) onDismissRef.current(id);
    }, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [clocks]);

  const pause = useCallback(() => { hovered.current = true; setClocks((c) => pauseClocks(c, Date.now())); }, []);
  const resume = useCallback(() => { hovered.current = false; setClocks((c) => resumeClocks(c, Date.now())); }, []);

  const run = (toast: KanbanToastItem, action: KanbanToastAction) => {
    onDismiss(toast.id);
    log.info('board', 'kanban toast action', { toastId: toast.id, action: action.label });
    void Promise.resolve().then(action.run).catch((err: unknown) => {
      log.warn('board', 'kanban toast action failed', { toastId: toast.id, action: action.label, error: String(err) });
    });
  };

  if (toasts.length === 0) return <span ref={anchorRef} className="kanban-toasts-anchor" hidden />;
  const { shown, folded, foldText } = foldToasts(toasts, expanded);
  return (
    <>
    <span ref={anchorRef} className="kanban-toasts-anchor" hidden />
    <div
      className="kanban-toasts"
      data-testid="kanban-toasts"
      role="status"
      aria-live="polite"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(); }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {shown.map((t) => (
        <div key={t.id} className={`kanban-toast${t.tone === 'error' ? ' is-error' : ''}`} data-testid="kanban-toast" data-toast-id={t.id}>
          {/* R3-18: text and actions wrap among themselves; the close button keeps the top right. */}
          <div className="kanban-toast-main">
          <span className="kanban-toast-text">{t.text}</span>
          {(t.actions ?? []).map((a) => (
            <button
              key={a.label}
              type="button"
              className="kanban-toast-btn"
              data-testid={a.testId ?? 'kanban-toast-action'}
              onClick={() => run(t, a)}
            >{a.label}</button>
          ))}
          </div>
          <button
            type="button"
            className="kanban-toast-close"
            data-testid="kanban-toast-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => onDismiss(t.id)}
          >{ICON_CLOSE}</button>
        </div>
      ))}
      {folded > 0 && (
        <button type="button" className="kanban-toasts-more" data-testid="kanban-toasts-more" onClick={() => setExpanded(true)}>
          {foldText}
        </button>
      )}
    </div>
    </>
  );
}
