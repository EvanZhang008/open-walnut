/**
 * The value chips of a project's code source on the draft (experiment `project_first_start`):
 * one line per array-of-string input of the provider (a plugin's packages, say),
 *   Packages: [★ Alpha ×] [★ Beta ×] [+ Add]
 * the project's favourites ticked by default (★), × drops one for this start, and "+ Add" opens
 * a flyout with the project's suggestions filtered by what is typed, plus the typed text itself.
 * Above the pills row, like the isolated-workspace row it replaces for such a draft.
 */
import { useRef, useState, type RefObject } from 'react';
import type { StartSource } from '@/api/projects';
import { setDraftWorkspace, useDraftWorkspace } from '@/components/workspaces/draft-workspace-store';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import type { DraftRowUpdate } from './DraftWorkInPill';
import type { DraftColumn } from './draft-column';
import { addOptions, setSourceValues, sourceArrayFields, type SourceArrayField } from './draft-project-start';

export function DraftProjectSourceRow({ draft, source, onUpdate }: { draft: DraftColumn; source: StartSource | null; onUpdate: DraftRowUpdate }) {
  const fields = source ? sourceArrayFields(source, draft.fromProjectInputs) : [];
  // A Start that waited (projectStartRequest) or the server refused (a restored draft) says why
  // here; the next edit clears it.
  const startError = useDraftWorkspace(draft.id).startError;
  if (!fields.length && !startError) return null;
  const write = (key: string, values: string[]) => {
    onUpdate(draft.id, (d) => setSourceValues(d, key, values));
    if (startError) setDraftWorkspace(draft.id, { startError: undefined });
  };
  return (
    <div className="draft-project-source-row" data-testid="draft-project-source-row">
      {fields.map((f) => <FieldChips key={f.key} field={f} onChange={(values) => write(f.key, values)} />)}
      {startError && <span className="draft-workspace-note is-error" data-testid="draft-project-start-error">{startError}</span>}
    </div>
  );
}

function FieldChips({ field, onChange }: { field: SourceArrayField; onChange: (values: string[]) => void }) {
  const addRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const fav = new Set(field.favourites.map((v) => v.toLowerCase()));
  return (
    <div className="draft-source-field" role="group" aria-label={field.title} data-testid={`draft-source-field-${field.key}`}>
      <span className="draft-source-field-label">{field.title}:</span>
      {field.values.map((v) => (
        <span key={v} className="draft-source-value" data-testid="draft-source-value" data-value={v}
          title={fav.has(v.toLowerCase()) ? `${v}: one of the project's favourites` : v}>
          {fav.has(v.toLowerCase()) && <span className="draft-source-star" aria-label="favourite">★</span>}
          <span className="draft-source-value-name">{v}</span>
          <button type="button" className="draft-source-remove" aria-label={`Remove ${v}`} data-testid="draft-source-remove"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(field.values.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      {!field.values.length && <span className="draft-source-none">{field.required ? 'none yet, add one' : 'none'}</span>}
      <button ref={addRef} type="button" className="draft-source-add" data-testid="draft-source-add"
        aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}>+ Add</button>
      <AddFlyout open={open} anchorRef={addRef} field={field} onClose={() => setOpen(false)}
        onAdd={(v) => onChange([...field.values, v])} />
    </div>
  );
}

function AddFlyout({ open, anchorRef, field, onAdd, onClose }: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  field: SourceArrayField;
  onAdd: (value: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const { suggestions, freeText } = addOptions(field, typed);
  const add = (v: string) => { onAdd(v); setTyped(''); };
  return (
    <ProjectStartFlyout open={open} anchorRef={anchorRef} onClose={() => { setTyped(''); onClose(); }} label={`Add to ${field.title}`}
      className="project-start-add" testId="draft-source-add-flyout" minHeight={120}>
      <input
        className="psp-search is-sm"
        data-no-draft="search"
        data-testid="draft-source-add-input"
        placeholder={field.placeholder ? `Search or type, e.g. ${field.placeholder}` : 'Search or type a name…'}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = freeText ?? suggestions[0];
          if (v) add(v);
        }}
        autoFocus
      />
      {suggestions.length > 0 && <div className="psp-group">{typed.trim() ? 'Matching' : 'Used before'}</div>}
      {suggestions.map((s) => (
        <button key={s} type="button" className="psp-option" data-testid="draft-source-suggestion" onClick={() => add(s)}>{s}</button>
      ))}
      {freeText && (
        <button type="button" className="psp-option psp-option-free" data-testid="draft-source-free" onClick={() => add(freeText)}>
          Add “{freeText}”
        </button>
      )}
      {!suggestions.length && !freeText && <div className="psp-empty">Type a name to add it</div>}
    </ProjectStartFlyout>
  );
}
