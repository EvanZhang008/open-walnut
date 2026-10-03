/**
 * The draft's "Isolated workspace" switch, as a row of the draft's More menu
 * (DraftTaskMenuPopover), right under the Project section.
 *
 * It lives in the menu, not on the launch bar, so picking a folder adds nothing
 * to the bar: a row that appeared with the folder pushed the quick folder chips
 * up under the pointer (the bar is bottom-anchored). Turning it on shows the
 * provider body above the folder row (DraftWorkspaceRow); that growth follows
 * the user's own click. With no folder yet there is nothing to isolate, so the
 * row is disabled and says so.
 *
 * A row of the menu itself (inside its portal), so the menu's outside-click,
 * Escape and pointerdown rules already cover it.
 */
import { log } from '@/utils/log';
import { setDraftWorkspace, useDraftWorkspace } from './draft-workspace-store';
import '@/styles/workspaces.css';

export function DraftWorkspaceMenuItem({ draftId, hasFolder, onDone }: {
  draftId: string;
  /** The draft has a folder: the only thing a workspace can isolate. */
  hasFolder: boolean;
  /** Closes the menu, so the body it turns on is in view. */
  onDone: () => void;
}) {
  const choice = useDraftWorkspace(draftId);
  const on = choice.enabled && hasFolder;
  return (
    <>
      <button
        type="button"
        className={`task-kebab-item draft-workspace-menu-item${on ? ' task-kebab-item-active' : ''}`}
        data-testid="draft-menu-workspace"
        aria-pressed={on}
        disabled={!hasFolder}
        title={!hasFolder
          ? 'Pick a folder first: the workspace is a working copy of that folder'
          : on
            ? 'The task gets its own working copy; click to run in the folder itself'
            : 'Give this task its own working copy (a git worktree, or a plugin workspace)'}
        onClick={(e) => {
          e.stopPropagation();
          setDraftWorkspace(draftId, { enabled: !on });
          log.info('workspace', 'draft option toggled', { draftId, enabled: !on, via: 'more-menu' });
          onDone();
        }}
      >
        <span className="draft-workspace-check" aria-hidden>{on ? '✓' : ''}</span>
        <span className="draft-workspace-menu-text">
          <span>Isolated workspace</span>
          {!hasFolder && <span className="draft-workspace-menu-hint" data-testid="draft-menu-workspace-hint">Pick a folder first</span>}
        </span>
      </button>
      <div className="task-kebab-divider" />
    </>
  );
}
