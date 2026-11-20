/**
 * The Org page's "Edit name and avatar…" (the "Org avatars" experiment): which row it is for,
 * how its name is changed, and the dialog itself. Off, `edit` is undefined and the row menu
 * shows no such row. It never reads the whole task store (tasks-context-readers-ratchet): the
 * dialog reads its one row, and a rename goes through the store's writers.
 */
import { useState, type ReactNode } from 'react';
import { editOrgNode } from '@/api/org';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { useExperimental } from '@/hooks/useExperimental';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { rowTaskId, type ChannelRow, shownName } from './org-channels-model';
import { OrgAvatarDialog, type AvatarDialogTarget, type RenameKind } from './OrgAvatarDialog';

export function useAvatarEditor(rows: readonly ChannelRow[]): { edit: ((row: ChannelRow) => void) | undefined; dialog: ReactNode } {
  const on = useExperimental('org_avatars');
  const actions = useTaskStoreActions();
  const [target, setTarget] = useState<AvatarDialogTarget | null>(null);

  const edit = useLeanCallback((row: ChannelRow) => {
    const taskId = rowTaskId(row);
    if (!taskId) return;
    setTarget({ taskId, name: shownName(row), main: row.kind === 'main', others: rows.map((r) => rowTaskId(r)).filter(Boolean) as string[] });
  }, [rows]);

  const rename = useLeanCallback(async (name: string, kind: RenameKind) => {
    if (!target || !kind) return;
    if (kind === 'vp') await editOrgNode(target.taskId, { name });
    else if (actions) await actions.update(target.taskId, { title: name });
  }, [target, actions]);

  return {
    edit: on ? edit : undefined,
    dialog: target ? <OrgAvatarDialog target={target} onRename={rename} onClose={() => setTarget(null)} /> : null,
  };
}
