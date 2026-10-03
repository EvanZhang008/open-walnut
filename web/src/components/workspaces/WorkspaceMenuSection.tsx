/**
 * The task kebab's "Workspace" row and its flyout: provider, state, folder,
 * branch, repositories, the reason it was kept or failed, Retry, and
 * "Remove workspace…".
 *
 * Menus & overlays rules (web/src/AGENTS.md): the details are their OWN
 * portalled flyout placed by useMenuPlacement (a workspace can list dozens of
 * repositories), pointerdown is stopped so dnd-kit never drags the row, and the
 * flyout reuses the `.task-kebab-project-flyout` class family so every host
 * menu's outside-click and scroll guards already exempt it.
 *
 * Remove asks the host first (a fail-closed probe of every repository) and the
 * confirm dialog names exactly what will be deleted and what stays. After the
 * confirm the host checks again and may still refuse; the row's state and error
 * (rendered here) say how it went.
 */
import { useCallback, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useAlert, useConfirm } from '@/hooks/useConfirm';
import { fetchWorkspaceRemoval, removeTaskWorkspace, retryTaskWorkspace } from '@/api/workspaces';
import { log } from '@/utils/log';
import type { TaskWorkspace } from './workspace-text';
import { hostName, isWorkspaceUsable, workspaceOf, workspaceStateLabel } from './workspace-text';
import '@/styles/workspaces.css';

function Fact({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="workspace-fact">
      <span className="workspace-fact-label">{label}</span>
      <span className={`workspace-fact-value${mono ? ' is-mono' : ''}`} title={value}>{value}</span>
    </div>
  );
}

function WorkspaceFlyout({ open, anchorRef, taskId, taskTitle, ws, onClose, afterAction }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  taskId: string;
  taskTitle: string;
  ws: TaskWorkspace;
  onClose: () => void;
  afterAction: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, listRef, { minHeight: 160, onAnchorLost: onClose });
  const confirm = useConfirm();
  const alert = useAlert();
  const [busy, setBusy] = useState<string | null>(null);

  const remove = useCallback(async () => {
    setBusy('Checking every repository…');
    try {
      const preview = await fetchWorkspaceRemoval(taskId);
      setBusy(null);
      onClose();
      afterAction();
      if (preview.degraded) {
        await alert({ title: 'Could not check the workspace', message: preview.error });
        return;
      }
      if (preview.decision.action === 'keep') {
        await alert({
          title: 'Walnut will not remove this workspace',
          message: <div className="workspace-confirm-body"><p>{preview.decision.reason}.</p><p>Commit (or discard) the work first, then try again.</p></div>,
        });
        return;
      }
      const ok = await confirm({
        title: `Remove the workspace of "${taskTitle}"?`,
        message: (
          <div className="workspace-confirm-body" data-testid="workspace-remove-plan">
            {preview.decision.plan.map((line) => <p key={line}>{line}</p>)}
          </div>
        ),
        confirmLabel: 'Remove workspace',
        danger: true,
      });
      if (!ok) return;
      await removeTaskWorkspace(taskId);
      log.info('workspace', 'manual removal started', { taskId, root: ws.root });
    } catch (err) {
      setBusy(null);
      const message = err instanceof Error ? err.message : String(err);
      log.warn('workspace', 'manual removal refused', { taskId, error: message });
      await alert({ title: 'Could not remove the workspace', message });
    }
  }, [taskId, taskTitle, ws.root, confirm, alert, onClose, afterAction]);

  const retry = useCallback(async () => {
    setBusy('Retrying…');
    try {
      await retryTaskWorkspace(taskId);
      onClose();
      afterAction();
    } catch (err) {
      setBusy(null);
      await alert({ title: 'Retry failed', message: err instanceof Error ? err.message : String(err) });
    }
  }, [taskId, alert, onClose, afterAction]);

  if (!open) return null;
  const repos = ws.repos ?? [];
  const showRepos = ws.provider !== 'git-worktree' && repos.length > 0;
  return createPortal(
    <div
      ref={listRef}
      className="task-kebab-project-flyout workspace-flyout"
      style={menuPlacementStyle(placement)}
      data-testid="workspace-flyout"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="workspace-flyout-head">
        <span className="workspace-flyout-title">{ws.provider_name ?? ws.provider}</span>
        <span className={`workspace-flyout-state is-${ws.state}`} data-testid="workspace-flyout-state">{workspaceStateLabel(ws)}</span>
      </div>
      {ws.state === 'creating' && ws.progress && <div className="workspace-flyout-note">{ws.progress}</div>}
      {ws.state === 'failed' && ws.error && <div className="workspace-flyout-note is-error">{ws.error}</div>}
      {ws.launch_error && <div className="workspace-flyout-note is-error">The session could not start: {ws.launch_error}</div>}
      {ws.state === 'kept' && <div className="workspace-flyout-note is-warn" data-testid="workspace-kept-reason">Kept: {ws.kept_reason ?? 'it still holds work'}</div>}
      {ws.error && ws.state !== 'failed' && <div className="workspace-flyout-note is-warn">{ws.error}</div>}
      <Fact label="Host" value={hostName(ws.host)} />
      <Fact label="Folder" value={ws.root} mono />
      {ws.cwd && ws.cwd !== ws.root && <Fact label="Sessions in" value={ws.cwd} mono />}
      <Fact label="Branch" value={ws.branch} mono />
      {ws.base_ref?.name && <Fact label="From" value={ws.base_ref.name} mono />}
      <Fact label="Made from" value={ws.anchor} mono />
      {showRepos && (
        <div className="workspace-fact">
          <span className="workspace-fact-label">Repositories</span>
          <span className="workspace-repos">
            {repos.map((r) => <span key={r.path} className="workspace-repo" title={r.path}>{r.name ?? r.path.split('/').pop()}</span>)}
          </span>
        </div>
      )}
      {busy && <div className="workspace-flyout-note">{busy}</div>}
      {(ws.state === 'failed' || ws.launch_error) && (
        <button className="task-kebab-item" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void retry(); }} data-testid="workspace-retry">
          <span className="task-kebab-icon">↻</span><span>Retry</span>
        </button>
      )}
      {isWorkspaceUsable(ws) && (
        <button className="task-kebab-item task-kebab-item-danger" disabled={!!busy} onClick={(e) => { e.stopPropagation(); void remove(); }} data-testid="workspace-remove">
          <span className="task-kebab-icon">✕</span><span>Remove workspace…</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

/** The kebab row; renders nothing for a task that never asked for a workspace. */
export function WorkspaceMenuSection({ task, afterAction }: {
  task: { id: string; title: string; workspace?: TaskWorkspace };
  afterAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const ws = workspaceOf(task);
  if (!ws) return null;
  return (
    <>
      <div className="task-kebab-project">
        <span className="task-kebab-project-label">Workspace</span>
        <button
          ref={btnRef}
          className={`task-kebab-project-current${open ? ' open' : ''}`}
          data-testid="workspace-menu-row"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <span className="task-kebab-project-current-name">{workspaceStateLabel(ws)}</span>
          <span className="task-kebab-project-caret">▾</span>
        </button>
      </div>
      <WorkspaceFlyout
        open={open}
        anchorRef={btnRef}
        taskId={task.id}
        taskTitle={task.title}
        ws={ws}
        onClose={() => setOpen(false)}
        afterAction={afterAction}
      />
    </>
  );
}
