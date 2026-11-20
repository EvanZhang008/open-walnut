/**
 * The Org page's "Edit name and avatar…" (the "Org avatars" experiment): which row it is for,
 * how its name is changed, and the dialog itself. Off, `edit` is undefined and the row menu
 * shows no such row.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { editOrgNode } from '@/api/org';
import { useTasksContext } from '@/contexts/TasksContext';
import { rowTaskId, type ChannelRow } from './org-channels-model';
import { OrgAvatarDialog, type AvatarDialogTarget } from './OrgAvatarDialog';
import { useOrgAvatars } from './useOrgAvatars';

export function useAvatarEditor(rows: readonly ChannelRow[]): { edit: ((row: ChannelRow) => void) | undefined; dialog: ReactNode } {
  const { on } = useOrgAvatars();
  const { tasks, update, refetch } = useTasksContext();
  const [target, setTarget] = useState<AvatarDialogTarget | null>(null);
  const others = useMemo(() => rows.map((r) => rowTaskId(r)).filter(Boolean) as string[], [rows]);

  const edit = useCallback((row: ChannelRow) => {
    const taskId = rowTaskId(row);
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    // A VP has a name of its own; a router or a project's one task is named by its title (unless
    // its router settings named it); the CEO keeps its name.
    const rename: AvatarDialogTarget['rename'] = row.kind === 'main' ? null
      : task?.org_role === 'lead' ? 'vp'
      : task?.org_name ? null : 'title';
    setTarget({ taskId, name: row.name, rename, others });
  }, [tasks, others]);

  const rename = useCallback(async (name: string) => {
    if (!target) return;
    if (target.rename === 'vp') await editOrgNode(target.taskId, { name });
    else if (target.rename === 'title') await update(target.taskId, { title: name });
    refetch();
  }, [target, update, refetch]);

  return {
    edit: on ? edit : undefined,
    dialog: target ? <OrgAvatarDialog target={target} onRename={rename} onClose={() => setTarget(null)} /> : null,
  };
}
