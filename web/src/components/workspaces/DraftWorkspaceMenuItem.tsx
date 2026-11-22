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
import { useId } from 'react';
import { log } from '@/utils/log';
import { ToggleSwitch } from '@/components/controls';
import { setDraftWorkspace, useDraftWorkspace } from './draft-workspace-store';
import { autoGivesWay } from './draft-workspace-model';
import { WORKSPACE_HINT } from './draft-workspace-model';
import '@/styles/workspaces.css';

export function DraftWorkspaceMenuItem({ draftId, hasFolder, onDone }: {
  draftId: string;
  /** The draft has a folder: the only thing a workspace can isolate. */
  hasFolder: boolean;
  /** Closes the menu, so the body it turns on is in view. */
  onDone: () => void;
}) {
  const choice = useDraftWorkspace(draftId);
  // A default with nothing to make (nothing claims the folder) reads as off.
  const on = choice.enabled && hasFolder && !autoGivesWay(choice);
  const switchId = useId();
  const toggle = (next: boolean) => {
    setDraftWorkspace(draftId, { enabled: next, touched: true, auto: false });
    log.info('workspace', 'draft option toggled', { draftId, enabled: next, via: 'more-menu' });
    onDone();
  };
  return (
    <>
      {/* The whole row is the switch's label: a press anywhere on it flips the switch. */}
      <label
        htmlFor={switchId}
        className="task-kebab-item draft-workspace-menu-item"
        aria-disabled={!hasFolder || undefined}
        title={!hasFolder
          ? 'Pick a folder first: the workspace is a working copy of that folder'
          : on
            ? 'The task gets its own working copy; click to run in the folder itself'
            : 'Give this task its own working copy (a git worktree, or a plugin workspace)'}
        onClick={(e) => e.stopPropagation()}
      >
        <ToggleSwitch
          id={switchId}
          size="sm"
          checked={on}
          disabled={!hasFolder}
          onChange={toggle}
          aria-labelledby={`${switchId}-name`}
          data-testid="draft-menu-workspace"
        />
        <span className="draft-workspace-menu-text">
          <span id={`${switchId}-name`}>Isolated workspace</span>
          <span className="draft-workspace-menu-hint" data-testid="draft-menu-workspace-hint">{hasFolder ? WORKSPACE_HINT : 'Pick a folder first'}</span>
        </span>
      </label>
      <div className="task-kebab-divider" />
    </>
  );
}
