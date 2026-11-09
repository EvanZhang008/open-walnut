/**
 * One setup or teardown run of a project script, as the task row keeps it:
 * its name and command, how it went, the line it is printing now, and the end
 * of its output behind a disclosure. Used by the workspace flyout and the
 * column that waits for the workspace.
 */
import type { ReactNode } from 'react';
import { scriptRunStatus, scriptSourceText, type WorkspaceScriptRun } from './script-run-text';
import { ScriptCommand } from './ScriptCommand';

export function ScriptRunCard({ role, run, action, openOutput }: {
  role: 'setup' | 'teardown';
  run: WorkspaceScriptRun;
  /** A button under the card (Run setup again). */
  action?: ReactNode;
  /** Show the output open (a failure the user came to read). */
  openOutput?: boolean;
}) {
  const label = role === 'setup' ? 'Setup' : 'On complete';
  return (
    <div className={`script-run-card is-${run.state}`} data-testid={`script-run-${role}`} data-state={run.state} data-untrusted={run.untrusted ? '' : undefined}>
      <div className="script-run-head">
        <span className="script-run-role">{label}</span>
        <span className="script-run-name" title={`From the ${scriptSourceText(run.source)}`}>{run.name}</span>
        <span className="script-run-status" data-testid={`script-run-${role}-status`}>
          {run.state === 'running' && <span className="workspace-pill-spin" aria-hidden />}
          {scriptRunStatus(run)}
        </span>
      </div>
      <ScriptCommand className="script-run-command" command={run.command} />
      {run.state === 'running' && run.progress && <div className="script-run-progress" data-testid={`script-run-${role}-progress`}>{run.progress}</div>}
      {run.untrusted && (
        <div className="script-run-reason" data-testid={`script-run-${role}-reason`}>
          This {run.source} is new or changed since it was last allowed, so Walnut did not run it by itself.
        </div>
      )}
      {run.output && (run.state !== 'running' || openOutput) && (
        <details className="script-run-output" open={openOutput}>
          <summary>Output</summary>
          <pre data-testid={`script-run-${role}-output`}>{run.output}</pre>
        </details>
      )}
      {action}
    </div>
  );
}
