/**
 * A workspace's setup or cleanup run with its whole output, opened from the
 * session's Scripts menu: the run is a job beside the session, not in its
 * terminal, so this is where its output shows. It reads the live run, so a
 * setup still going keeps printing here.
 */
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { ScriptRunCard } from './ScriptRunCard';
import type { WorkspaceScriptRun } from './script-run-text';
import '@/styles/workspaces.css';

export function ScriptOutputDialog({ role, run, onClose }: {
  role: 'setup' | 'teardown';
  run: WorkspaceScriptRun;
  onClose: () => void;
}) {
  useModalOverlay(onClose);
  const title = role === 'setup' ? 'Setup' : 'Cleanup';
  return createPortal(
    <div className="app-modal-overlay project-scripts-overlay" role="dialog" aria-modal="true" aria-label={`${title} ${run.name}`} onMouseDown={onClose}>
      <div className="app-modal project-scripts-dialog script-output-dialog" data-testid="script-output-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="project-scripts-head">
          <div className="app-modal-title">{title} · {run.name}</div>
          <button className="session-panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close">&times;</button>
        </div>
        <ScriptRunCard role={role} run={run} openOutput />
        {!run.output && <div className="project-scripts-empty">No output yet.</div>}
      </div>
    </div>,
    document.body,
  );
}
