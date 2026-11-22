/**
 * The values of a project's code source, right under the Where menu's Auto row (experiment
 * `project_first_start`, v6): one line per array-of-string input of the provider (a plugin's
 * packages, say),
 *   [✓ alpha] [✓ beta] [  gamma] [+ Add]
 * the project's favourites ticked by default, a click ticks or unticks one for this start, and
 * "+ Add" takes a typed name. What is ticked is what Start sends (projectStartRequest).
 */
import { useState } from 'react';
import * as ICONS from '@/components/common/Icons';
import { Chip, ChipGroup } from '@/components/controls';
import type { StartSource } from '@/api/projects';
import { setDraftWorkspace, useDraftWorkspace } from '@/components/workspaces/draft-workspace-store';
import type { DraftRowUpdate } from './useDraftWhere';
import type { DraftColumn } from './draft-column';
import { addOptions, setSourceValues, sourceArrayFields, type SourceArrayField } from './draft-project-start';

/** How many unticked suggestions a line offers before "+ Add". */
const OFFERED = 6;

export function DraftSourcePackages({ draft, source, onUpdate }: { draft: DraftColumn; source: StartSource; onUpdate: DraftRowUpdate }) {
  const fields = sourceArrayFields(source, draft.fromProjectInputs);
  // A Start that waited (a required list empty) or the server refused says why under the row; an edit clears it.
  const startError = useDraftWorkspace(draft.id).startError;
  if (!fields.length) return null;
  const write = (key: string, values: string[]) => {
    onUpdate(draft.id, (d) => setSourceValues(d, key, values));
    if (startError) setDraftWorkspace(draft.id, { startError: undefined });
  };
  return (
    <div className="draft-v6-packages" data-testid="draft-project-source-row">
      {fields.map((f) => <FieldChips key={f.key} field={f} onChange={(values) => write(f.key, values)} />)}
    </div>
  );
}

function FieldChips({ field, onChange }: { field: SourceArrayField; onChange: (values: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const chosen = new Set(field.values.map((v) => v.toLowerCase()));
  const offered = [...field.values, ...field.suggestions.filter((s) => !chosen.has(s.toLowerCase())).slice(0, OFFERED)];
  const add = () => {
    const { freeText, suggestions } = addOptions(field, typed);
    const v = freeText ?? suggestions[0];
    if (v) onChange([...field.values, v]);
    setTyped('');
    setAdding(false);
  };
  return (
    <ChipGroup className="draft-v6-package-field" role="group" aria-label={field.title} data-testid={`draft-source-field-${field.key}`}>
      {/* The shared chips (standard.md "Choice controls"): on is aria-pressed, a pick among options that wrap. */}
      {offered.map((v) => {
        const on = chosen.has(v.toLowerCase());
        return (
          <Chip key={v} pressed={on} leading={on ? <span className="draft-v6-package-check" aria-hidden="true">{ICONS.ICON_CHECK}</span> : undefined}
            data-testid="draft-source-value" data-value={v} title={on ? `${v}: in this start. Click to leave it out` : `${v}: click to add it to this start`}
            onClick={() => onChange(on ? field.values.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...field.values, v])}>
            {v}
          </Chip>
        );
      })}
      {adding ? (
        <input
          className="is-sm draft-v6-package-input"
          data-no-draft="search"
          data-testid="draft-source-add-input"
          aria-label={`Add to ${field.title}`}
          placeholder={field.placeholder ? `e.g. ${field.placeholder}` : 'A name…'}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => { if (!typed.trim()) setAdding(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
            if (e.key === 'Escape' && typed) { e.stopPropagation(); setTyped(''); setAdding(false); }
          }}
          autoFocus
        />
      ) : (
        <Chip pressed={undefined} data-testid="draft-source-add" onClick={() => setAdding(true)}>+ Add</Chip>
      )}
      {field.required && !field.values.length && <span className="draft-v6-package-none">Pick at least one to start</span>}
    </ChipGroup>
  );
}
