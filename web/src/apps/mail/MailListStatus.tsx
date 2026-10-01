/**
 * The list status strip (spec 9.0): one line per job of THIS view (a rule save, an unsubscribe
 * batch, a bulk result whose own row is off screen), newest first, at most three. In the middle
 * column under the header, so it is visible at every width (the pane note is not, at narrow width).
 */
import { dismissMailListStatus, useMailListStatus } from './mail-groups-bus';

export function MailListStatus({ viewKey }: { viewKey: string }) {
  const notes = useMailListStatus(viewKey);
  return (
    <div className="mail-list-status" data-testid="mail-list-status" role="status" aria-live="polite">
      {notes.map((note) => (
        <p key={note.id} className="mail-list-status-line" data-tone={note.tone ?? 'info'} data-status-id={note.id}>
          <span className="mail-list-status-text">{note.text}</span>
          {(note.actions ?? []).map((action) => (
            <button
              key={action.label}
              type="button"
              className="mail-text-btn mail-list-status-action"
              {...(action.testId ? { 'data-testid': action.testId } : {})}
              onClick={() => { action.run(); }}
            >
              {action.label}
            </button>
          ))}
          {note.sticky && (
            <button
              type="button"
              className="mail-text-btn mail-list-status-close"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => { dismissMailListStatus(note.id); }}
            >
              Dismiss
            </button>
          )}
        </p>
      ))}
    </div>
  );
}
