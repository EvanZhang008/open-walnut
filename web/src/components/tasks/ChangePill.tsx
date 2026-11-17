/**
 * A change link tag with its status (experiment `change_status`): the link's pill with a dot in
 * its tone and a few words (`CR-1001 · prod-w1 baking`, changePillState), and on a click its
 * status card (ChangeCard.tsx) instead of the link; the card's "Open review" is the old click.
 * The task's snapshot (Task.change_status, written by the server's watcher) arrives with every
 * task:updated; Refresh asks the server to read the task's changes now.
 *
 * Overlay rules (web/src/AGENTS.md): the card is portalled to <body>, placed by useMenuPlacement,
 * stops pointerdown (rows are dnd-kit draggables), and closes on an outside pointerdown or Escape,
 * both heard in the capture phase (the pills beside it stop their own). Inside the session
 * header's tags flyout the card is that flyout's child portal: it closes first on Escape.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChangeSnapshot } from '../../../../src/core/changes/model';
import { changePillState } from '../../../../src/core/changes/model';
import { apiPost } from '@/api/client';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { ChangeCard } from './ChangeCard';
import { TagChip } from './TagChip';
import '@/styles/change-card.css';

/** The refresh route's answer. */
interface ChangesAnswer { enabled: boolean; changes: ChangeSnapshot[] }

/** Reading every change of the task can take a provider's whole deadline. */
const REFRESH_MS = 30_000;

export function ChangePill({ tag, snap, taskId, inline, linkName }: {
  tag: string; snap: ChangeSnapshot; taskId: string; inline?: boolean; linkName?: string;
}) {
  const [open, setOpen] = useState(false);
  // What Refresh read, until the task's own snapshot catches up with it.
  const [fresh, setFresh] = useState<ChangeSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const pillRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shown = fresh && fresh.checkedAt > snap.checkedAt ? fresh : snap;
  const { tone, text } = changePillState(shown);
  // Inside the session header's tags list the card opens under the whole list, never over the
  // other pills; elsewhere under the pill.
  const listRef = useRef<HTMLElement | null>(null);
  listRef.current = open ? pillRef.current?.closest<HTMLElement>('.session-header-labels-flyout') ?? null : null;
  const placement = useMenuPlacement(open, pillRef, cardRef, {
    align: 'start', preferSide: 'down', minHeight: 160, gap: 6, verticalAnchorRef: listRef, onAnchorLost: () => setOpen(false),
  });

  const close = useLeanCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) pillRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    setRefreshError(null);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (pillRef.current?.contains(t) || cardRef.current?.contains(t))) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(!!cardRef.current?.contains(document.activeElement));
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  const refresh = useLeanCallback(() => {
    setRefreshing(true);
    setRefreshError(null);
    apiPost<ChangesAnswer>(`/api/tasks/${encodeURIComponent(taskId)}/changes/refresh`, {}, { timeoutMs: REFRESH_MS })
      .then((answer) => {
        const next = answer.changes.find((c) => c.url === snap.url);
        if (next) setFresh(next);
      })
      .catch((err: unknown) => {
        log.warn('tasks', 'change refresh failed', { taskId, url: snap.url, error: String(err) });
        setRefreshError('Refresh failed');
      })
      .finally(() => setRefreshing(false));
  }, [taskId, snap.url]);

  return (
    <>
      <TagChip
        tag={tag}
        inline={inline}
        whole
        linkName={linkName}
        status={{ tone, text }}
        onActivate={() => setOpen((v) => !v)}
        expanded={open}
        anchorRef={pillRef}
      />
      {open && createPortal(
        <div
          ref={cardRef}
          className="change-card change-card-popover"
          role="dialog"
          aria-label={`${shown.label}: ${text}`}
          data-testid="change-card"
          data-tone={tone}
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <ChangeCard snap={shown} taskId={taskId} refreshing={refreshing} refreshError={refreshError} onRefresh={refresh} />
        </div>,
        document.body,
      )}
    </>
  );
}
