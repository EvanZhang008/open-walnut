/** A task row's workspace pill: preparing / failed / kept / ready. Nothing once removed. */
import type { TaskWorkspace } from './workspace-text';
import { workspaceOf, workspacePill } from './workspace-text';
import '@/styles/workspaces.css';

export function WorkspacePill({ task }: { task: { workspace?: TaskWorkspace } }) {
  const pill = workspacePill(workspaceOf(task));
  if (!pill) return null;
  return (
    <span
      className={`todo-item-due-pill workspace-pill workspace-pill-${pill.tone}`}
      title={pill.title}
      data-testid="workspace-pill"
      data-tone={pill.tone}
    >
      {pill.tone === 'busy' && <span className="workspace-pill-spin" aria-hidden />}
      <span className="workspace-pill-glyph" aria-hidden>⎇</span>
      {pill.text}
    </span>
  );
}
