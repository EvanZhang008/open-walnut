/**
 * The `Tracking` detail-section's PRESENTATION — no data layer, no markdown.
 *
 * Split out of ProjectTrackingBlock so the states are gradable in the node-env
 * test tiers: the renderer (`@/utils/markdown`) pulls in `dompurify`, which lives
 * in web/node_modules and does not resolve at the repo root, so a test that
 * imported it would die at collection with zero assertions.
 *
 * States, and why each exists:
 *   - `present`   the note read fine → render it.
 *   - `missing`   the project's `tracking_note` key names a note the vault does
 *                 not have any more (the human deleted or moved it). Say exactly
 *                 that, keep the path visible, and offer nothing broken.
 *   - `unreadable` the read FAILED for some other reason. A failed read is not
 *                 an empty answer: reporting it as "the note is gone" would be a
 *                 confident wrong claim about the user's vault.
 *   - `loading`   first read in flight.
 * The fifth state — no `tracking_note` key at all — is the ABSENCE of this whole
 * section (ProjectTrackingBlock returns null), never an empty box.
 */

export type TrackingNoteState =
  | { status: 'loading' }
  /**
   * `sanitizedHtml` MUST come from renderNoteMarkdown() (@/utils/markdown) —
   * the vault's own renderer, already DOMPurify'd with the note policy. It is
   * the ONLY legal producer: this component hands the string straight to
   * dangerouslySetInnerHTML and cannot check it.
   */
  | { status: 'present'; sanitizedHtml: string }
  | { status: 'missing' }
  | { status: 'unreadable'; message: string };

/**
 * Does this project have a tracking note at all?
 *
 * The rule the detail pane hangs the whole section on: no `tracking_note` key
 * means NO SECTION, not an empty box — a project nobody tracks should not grow a
 * placeholder telling the human about a feature they did not ask for. Its own
 * function so the rule is gradable without the markdown renderer in the graph.
 */
export function hasTrackingNote(notePath?: string): notePath is string {
  return typeof notePath === 'string' && notePath.trim().length > 0;
}

interface ProjectTrackingViewProps {
  /** Vault-relative path (WITH .md) from `task_projects.metadata.tracking_note`. */
  notePath: string;
  state: TrackingNoteState;
  /** Jump to the note on the Notes page (tabs, backlinks, editing). */
  onOpenInNotes: () => void;
}

export function ProjectTrackingView({ notePath, state, onOpenInNotes }: ProjectTrackingViewProps) {
  return (
    <div className="detail-section project-tracking-section">
      <div className="detail-section-title">
        Tracking
        {/* Only offered when there IS a note to open — a button that lands on a
            missing note is the "nothing broken" rule's counterexample. */}
        {state.status === 'present' && (
          <button
            type="button"
            className="project-tracking-open"
            onClick={onOpenInNotes}
            title={`Open ${notePath} on the Notes page (tabs, backlinks, editing)`}
          >
            Open in Notes
          </button>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="detail-memory-text text-muted">Reading {notePath}…</p>
      )}

      {state.status === 'missing' && (
        <p className="detail-memory-text text-muted">
          This project tracks <code className="project-tracking-path">{notePath}</code>, but that note
          is not in the vault any more. The next tracking update writes a fresh one there.
        </p>
      )}

      {state.status === 'unreadable' && (
        <p className="detail-memory-text text-muted">
          Couldn’t read <code className="project-tracking-path">{notePath}</code> ({state.message}).
          The note itself is untouched.
        </p>
      )}

      {state.status === 'present' && (
        <div
          className="todo-detail-note markdown-body project-tracking-note"
          dangerouslySetInnerHTML={{ __html: state.sanitizedHtml }}
        />
      )}
    </div>
  );
}
