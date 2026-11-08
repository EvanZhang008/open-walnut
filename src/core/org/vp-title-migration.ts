/**
 * An open VP whose task an older build titled "<project> lead" is renamed "<project> VP"
 * (2026-11-02, the user: "after we rename it from lead to vp, why the task name still walnut
 * lead"). Only the title Walnut wrote: one the user changed (it no longer reads its project's
 * name plus " lead") stays, and a closed VP keeps its old title. Run once per boot on the primary;
 * a second run finds nothing to do. The old default Main title becomes CEO by the same rule.
 */

import type { Task } from '../types.js';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { orgTasks, withOrgLock } from './org-store.js';
import { CEO_LABEL, projectKey, vpTaskTitle } from './org-tree.js';

type VpTitleLike = Pick<Task, 'title' | 'org_role' | 'phase' | 'project'>;

/** The title an open VP's task should now carry, or null when it keeps the one it has. */
export function legacyVpTitleFix(task: VpTitleLike): string | null {
  if (task.phase === 'COMPLETE') return null;
  if (task.org_role === 'main') return task.title === 'Main' ? CEO_LABEL : null;
  if (task.org_role !== 'lead') return null;
  const m = /^(.*\S) lead$/.exec(task.title ?? '');
  if (!m || !projectKey(m[1]) || projectKey(m[1]) !== projectKey(task.project)) return null;
  return vpTaskTitle(m[1]);
}

/** Renames every open VP still titled the old way; answers how many it renamed. */
export function renameLegacyVpTitles(): Promise<number> {
  return withOrgLock(async () => {
    const { updateTaskRaw } = await import('../task-manager.js');
    let renamed = 0;
    for (const t of await orgTasks()) {
      if (!legacyVpTitleFix(t)) continue;
      // Read again under the row lock: a title the user changed meanwhile stays.
      const { changed, task } = await updateTaskRaw(t.id, (cur) => {
        const title = legacyVpTitleFix(cur);
        return title ? { title } : null;
      }, { source: 'internal' });
      if (!changed || !task) continue;
      renamed++;
      log.task.info('org: default task title updated', { taskId: t.id, from: t.title, to: task.title });
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'org' });
    }
    return renamed;
  });
}
