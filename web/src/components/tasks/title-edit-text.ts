// A task title span shows orgDisplayTitle and edits the stored title; pure, so tests need no React.
import { orgDisplayTitle } from '../../../../src/core/org/org-tree';

export type TitledTask = { id: string; title: string; project?: string; org_role?: string; org_name?: string };

/** What the title span holds: the display name while it shows, the stored title while it edits. */
export function titleSpanText(task: TitledTask, editing: boolean): string {
  return editing ? task.title : orgDisplayTitle(task);
}

export function titleEditRename(storedTitle: string, text: string): string | null {
  const trimmed = text.trim();
  return trimmed && trimmed !== storedTitle ? trimmed : null;
}
