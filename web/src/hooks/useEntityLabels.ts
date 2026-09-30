import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  getEntityLabelsVersion,
  peekTaskLabel,
  subscribeEntityLabels,
  type TaskLabel,
} from '@/stores/entity-label-store';
import { renderMarkdownWithRefs, type RenderMarkdownOptions } from '@/utils/markdown';

/**
 * Subscribe to the entity-label store version. Place this in the LEAF that
 * calls renderMarkdownWithRefs (React.memo blocks parent-propagated renders,
 * not a component's own store subscription), so pills re-render when the task
 * store loads after chat history (boot race) or an observed title changes.
 */
export function useEntityLabelsVersion(): number {
  return useSyncExternalStore(
    subscribeEntityLabels,
    getEntityLabelsVersion,
    getEntityLabelsVersion,
  );
}

/**
 * renderMarkdownWithRefs with the entity-label version wired into the memo —
 * use this instead of a hand-rolled useMemo so the version dep can't be
 * forgotten (a missed dep = permanently stale pill on that surface).
 */
export function useRenderedMarkdown(
  text: string,
  sessionCwd?: string,
  host?: string,
  taskIds?: RenderMarkdownOptions['taskIds'],
): string {
  const version = useEntityLabelsVersion();
  return useMemo(
    () => renderMarkdownWithRefs(text, sessionCwd, host, taskIds ? { taskIds } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the label lookups inside
    [text, sessionCwd, host, taskIds, version],
  );
}

/** Live task label for surfaces that render refs as React nodes (not HTML strings). */
export function useTaskLabel(id: string | null | undefined): TaskLabel | undefined {
  const getSnapshot = useCallback(
    () => (id ? peekTaskLabel(id) : undefined),
    [id],
  );
  return useSyncExternalStore(subscribeEntityLabels, getSnapshot, getSnapshot);
}
