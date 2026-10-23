/**
 * The question map's × (2026-10-15, the user: "shouldn't there be a x button
 * that will archive?"). On a question row's hover or focus it takes the status
 * word's place and archives the question, with the panel toast's Undo. A question
 * with open follow-ups asks first, the same question the page header and the
 * drawer ask.
 *
 * The confirm is held by the map, not by its list: in the rail shape the list
 * closes when the pointer leaves it, and the confirm sits outside it (a portal).
 */
import { useCallback, useState, type MutableRefObject, type ReactNode } from 'react';
import { ThreadCloseIcon } from '@/components/sessions/ThreadIcons';
import { ThreadConfirm } from '@/components/sessions/ThreadConfirm';
import { alsoDoneTitle } from '@/components/sessions/ThreadStackHeader';

export interface MapArchiveApi {
  /** Archive the question; `withFollowUps` takes its open follow-ups too. */
  archive: (key: string, withFollowUps: boolean) => void;
  /** Open (or suggested) follow-ups below it, visible ones only. */
  openBelowCount: (key: string) => number;
}

/** The × itself. Out of the Tab order (the map is one tab stop); ArrowRight on
 *  its row reaches it. A mouse press does not take focus from where it was. */
export function MapArchiveButton({ stop, title, onPress }: {
  stop: string; title: string; onPress: (el: HTMLElement, byKey: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="thread-map-archive"
      tabIndex={-1}
      data-map-archive={stop}
      title="Archive"
      aria-label={`Archive “${title}”`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onPress(e.currentTarget, e.detail === 0); }}
    >
      <ThreadCloseIcon size={10} />
    </button>
  );
}

interface Pending { key: string; anchor: HTMLElement; count: number }

/**
 * `request` archives at once or opens the follow-ups confirm. `confirming` is the
 * map's ref, true while the confirm is up, so its close-out handlers hold the
 * rail's list open; `settled` runs once the confirm is answered or dismissed.
 */
export function useMapArchive(api: MapArchiveApi | undefined, confirming: MutableRefObject<boolean>, settled: () => void): {
  request: (key: string, anchor: HTMLElement) => void;
  confirm: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const request = useCallback((key: string, anchor: HTMLElement) => {
    if (!api) return;
    const count = api.openBelowCount(key);
    if (count > 0) { confirming.current = true; setPending({ key, anchor, count }); return; }
    api.archive(key, false);
  }, [api, confirming]);
  const finish = (withFollowUps: boolean | null) => {
    const p = pending;
    confirming.current = false;
    setPending(null);
    if (p && api && withFollowUps !== null) api.archive(p.key, withFollowUps);
    settled();
  };
  const confirm = pending ? (
    <ThreadConfirm
      anchorEl={pending.anchor}
      title={alsoDoneTitle(pending.count)}
      confirmLabel="Archive all"
      cancelLabel="Only this one"
      neutral
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
      onDismiss={() => finish(null)}
    />
  ) : null;
  return { request, confirm };
}
