/**
 * "+ New Director": the last row of an opened Directors fold (OrgLeaders) and of the DIRECTORS section
 * (OrgDirectorSection). A click turns it into a name input in place: Enter makes the task (a Director,
 * in the project picked beside it when there are several, the first by default), NOT started, and opens
 * it beside the page, where the user's first message starts it; Escape, or leaving it empty, closes it.
 * A VP's right-click "New Director…" opens it already editing (director-actions.ts askNewDirector).
 *
 * Inside the Org list's listbox the idle row is an option (all a listbox may hold); the editing row keeps
 * its keys to itself, so Up and Down do not walk the list from inside the input.
 */
import { useEffect, useRef, useState } from 'react';
import { log } from '@/utils/log';
import { MicInput } from '@/components/common/BoxMic';
import { useDirectorActions, type DirectorProject } from './director-actions';

interface Props {
  projects: readonly DirectorProject[];
  /** The project picked at first (else the first one). */
  defaultProject?: string | undefined;
  inList: boolean;
  /** Editing from the start (a VP's "New Director…"). */
  editing: boolean;
  onEditing: (on: boolean) => void;
  /** Closes a sheet over the page (the Org chart) before the new task opens. */
  onLeave?: (() => void) | undefined;
}

const projectLabel = (p: DirectorProject) => (p.vpName && p.vpName !== p.name ? `${p.name} (${p.vpName})` : p.name);

export function OrgNewDirector({ projects, defaultProject, inList, editing, onEditing, onLeave }: Props) {
  const actions = useDirectorActions();
  const [title, setTitle] = useState('');
  const first = projects.find((p) => p.project === defaultProject)?.project ?? projects[0]?.project ?? '';
  const [project, setProject] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLDivElement>(null);
  // A new ask (another VP's "New Director…") picks its own project.
  useEffect(() => { if (editing) { setProject(first); input.current?.focus(); form.current?.scrollIntoView({ block: 'nearest' }); } }, [editing, first]);
  if (!projects.length) return null;
  const close = () => { setTitle(''); setError(null); onEditing(false); };
  const submit = () => {
    const name = title.replace(/\s+/g, ' ').trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    actions.create(name, project || first, onLeave)
      .then(() => close())
      .catch((err) => {
        log.warn('org-page', 'new director not made', { project, error: err instanceof Error ? err.message : String(err) });
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };
  if (!editing) {
    return (
      <button
        type="button"
        className="org-new-director"
        data-testid="org-new-director"
        {...(inList ? { role: 'option', 'aria-selected': false } : {})}
        title="Make a task that is a Director from the start; your first message in its chat starts it"
        onClick={() => onEditing(true)}
      ><span aria-hidden="true">+</span> New Director</button>
    );
  }
  return (
    <div
      ref={form}
      className="org-new-director-form"
      data-testid="org-new-director-form"
      role={inList ? 'presentation' : undefined}
      // Its keys are its own: the list's Up and Down (and a sheet's Escape) never take them.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <MicInput
        ref={input}
        className="org-new-director-input"
        fieldClassName="mic-field-compact mic-field-grow"
        // A one-line name, made on Enter (as a rename is): nothing long to keep.
        data-no-draft="rename"
        data-testid="org-new-director-input"
        aria-label="New Director's title"
        placeholder="Director's title"
        value={title}
        disabled={busy}
        setText={setTitle}
        // Enter makes it once a title still being dictated is in (the box's send gate).
        onEnter={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
        onBlur={(e) => {
          // Left empty for somewhere else (not its own mic or project picker): it closes.
          if (!title.trim() && !form.current?.contains(e.relatedTarget as Node | null)) close();
        }}
      />
      {projects.length > 1 && (
        <select
          className="org-new-director-project"
          data-testid="org-new-director-project"
          aria-label="Its project"
          value={project}
          disabled={busy}
          onChange={(e) => setProject(e.target.value)}
        >
          {projects.map((p) => <option key={p.project} value={p.project}>{projectLabel(p)}</option>)}
        </select>
      )}
      {error && <div className="org-new-director-error" role="alert" data-testid="org-new-director-error">{error}</div>}
    </div>
  );
}
