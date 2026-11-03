/**
 * What Tree Mode's path bar draws (ThreadPathBar.tsx), from the trail and the
 * question tree: one segment per level, and the questions at one level for its
 * list. Pure; tested in tests/web/tree-split-state.test.ts.
 */
import type { PathBarLevelItem, PathBarSegment } from '@/components/sessions/ThreadPathBar';
import type { ThreadLiveState, ThreadMetaIndex } from '@/utils/thread-meta';
import { displayTitleOf, viewStatusOf } from '@/utils/thread-meta';
import { PENDING_ROW_LABEL, MAIN_TITLE } from '@/utils/thread-stack-state';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import { levelHeading, levelKeys, type SegmentRole } from '@/utils/tree-split-state';

export function pathBarSegments(
  trail: readonly string[],
  roles: readonly SegmentRole[],
  tree: ThreadTree,
  index: ThreadMetaIndex,
  labels: ReadonlyMap<string, string>,
): PathBarSegment[] {
  return trail.map((key, i) => {
    const node = tree.byKey.get(key);
    const role = roles[i] ?? null;
    if (key === ROOT_THREAD_KEY) return { key, title: MAIN_TITLE, role };
    if (!node) return { key, title: PENDING_ROW_LABEL, role };
    const number = labels.get(key);
    return { key, ...(number ? { number } : {}), title: displayTitleOf(node, index).title, role };
  });
}

export function pathBarLevelItems(
  tree: ThreadTree,
  trail: readonly string[],
  j: number,
  a: {
    hidden: ReadonlySet<string>;
    index: ThreadMetaIndex;
    live: ReadonlyMap<string, ThreadLiveState>;
    unread: ReadonlySet<string>;
    labels: ReadonlyMap<string, string>;
  },
): PathBarLevelItem[] {
  // Main's list is the questions on Main: the one open below it is current.
  const current = trail[Math.max(j, 1)];
  return levelKeys(tree, trail, j, a.hidden).map((key) => {
    const node = tree.byKey.get(key)!;
    const number = a.labels.get(key);
    return {
      key,
      ...(number ? { number } : {}),
      title: displayTitleOf(node, a.index).title,
      status: viewStatusOf(node, a.index, a.live),
      hue: node.hue,
      depth: node.depth,
      unread: a.unread.has(key),
      current: key === current,
    };
  });
}

export function pathBarHeading(trail: readonly string[], j: number, labels: ReadonlyMap<string, string>): string {
  return levelHeading(j, j >= 2 ? labels.get(trail[j - 1]) : undefined);
}
