/**
 * "Where these come from": one line per launch value (engine, model, permission
 * mode) with the layer that decided it: this task, its project, the folder's last
 * pick, the global default or the fallback engine (utils/launch-source.ts). Shown
 * at the top of the model picker, on a new task's draft and on a running session.
 */
import { launchSourceTag, type LaunchSourceRow } from '@/utils/launch-source';
import '@/styles/launch-source.css';

export function LaunchSourceNote({ rows, title = 'Where these come from', project, hint, action }: {
  rows: LaunchSourceRow[];
  title?: string;
  /** The project whose defaults any row came from: named once, under the title. */
  project?: string;
  /** One more line under the rows (what a pick here does). */
  hint?: string;
  /** One button under the rows ("Use project defaults"). */
  action?: { label: string; onClick: () => void };
}) {
  if (rows.length === 0) return null;
  const fromProject = project && rows.some((r) => r.source === 'project');
  return (
    <div className="launch-source-note" data-testid="launch-source-note">
      <div className="launch-source-note-title">{title}</div>
      {fromProject && <div className="launch-source-note-project" data-testid="launch-source-project">Project defaults of <strong>{project}</strong></div>}
      {rows.map((r) => (
        <div key={r.key} className="launch-source-row" data-key={r.key} data-source={r.source}>
          <span className="launch-source-label">{r.label}</span>
          <span className="launch-source-value">{r.value}</span>
          <LaunchSourceTag row={r} />
        </div>
      ))}
      {hint && <div className="launch-source-note-hint">{hint}</div>}
      {action && (
        <button type="button" className="launch-source-note-action" data-testid="launch-source-reset" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** The tag alone ("Project"), for a pill's corner. */
export function LaunchSourceTag({ row }: { row: Pick<LaunchSourceRow, 'source' | 'words'> }) {
  return <span className={`launch-source-tag is-${row.source}`} title={row.words} aria-label={row.words}>{launchSourceTag(row.source)}</span>;
}
