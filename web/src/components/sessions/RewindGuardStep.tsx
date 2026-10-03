import { createPortal } from 'react-dom';
import type { RewindGuardFile, RewindGuardResult } from '@/api/session-turns';
import '@/styles/turn-snapshots.css';

/**
 * The rewind dialog's second step, shown only when restoring files would undo
 * someone else's work: files changed after this session last wrote them
 * (providers/turn-guard-core.ts), with who changed each one when the daemon
 * could tell. Three ways out: rewind the conversation and leave the files,
 * restore anyway, or cancel.
 */

const MAX_ROWS = 8;

function writerLine(f: RewindGuardFile): string {
  const named = f.writers.filter((w) => w.consistent);
  if (!named.length) return 'Edited outside this session';
  const titles = named.map((w) => w.title?.trim() || `session ${w.sid.slice(0, 8)}`);
  if (titles.length === 1) return `Changed by “${titles[0]}”`;
  if (titles.length === 2) return `Changed by “${titles[0]}” and “${titles[1]}”`;
  return `Changed by “${titles[0]}” and ${titles.length - 1} other sessions`;
}

interface RewindGuardStepProps {
  guard: RewindGuardResult;
  busy: boolean;
  error: string | null;
  onConversationOnly: () => void;
  onRestoreAnyway: () => void;
  onCancel: () => void;
}

export function RewindGuardStep({ guard, busy, error, onConversationOnly, onRestoreAnyway, onCancel }: RewindGuardStepProps) {
  const files = guard.conflicts;
  const n = files.length;
  return createPortal(
    <div className="app-modal-overlay rewind-dialog-overlay" role="dialog" aria-modal="true" aria-label="Files changed since this session wrote them" onMouseDown={onCancel}>
      <div className="app-modal rewind-dialog rewind-guard-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{n === 1 ? 'A file changed' : `${n} files changed`} after this session wrote {n === 1 ? 'it' : 'them'}</div>
        <div className="app-modal-message">
          Restoring files puts back this session’s earlier version and throws away {n === 1 ? 'this change' : 'these changes'}.
        </div>
        <div className="rewind-guard-files" data-testid="rewind-guard-files">
          {files.slice(0, MAX_ROWS).map((f) => (
            <div key={f.path} className="rewind-guard-file" title={f.path}>
              <span className="rewind-guard-file-path">{f.rel ?? f.path}{f.exists ? '' : ' (deleted)'}</span>
              <span className="rewind-guard-file-writer">{writerLine(f)}</span>
            </div>
          ))}
          {n > MAX_ROWS && <div className="rewind-dialog-file-more">+{n - MAX_ROWS} more</div>}
        </div>
        {error && <div className="rewind-dialog-error">{error}</div>}
        <div className="app-modal-actions rewind-guard-actions">
          <button type="button" className="app-modal-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="app-modal-btn primary danger" onClick={onRestoreAnyway} disabled={busy}>Restore anyway</button>
          <button type="button" className="app-modal-btn primary" onClick={onConversationOnly} disabled={busy}>
            {busy ? 'Rewinding…' : 'Rewind conversation only'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
