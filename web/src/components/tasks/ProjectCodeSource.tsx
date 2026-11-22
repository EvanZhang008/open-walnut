/**
 * A project's "Code source" (experiment `project_first_start`): where a new task of the project
 * gets its code. "Folder" is today's flow (no `workspace_source`); every workspace provider in
 * the server's catalog (git worktree, a plugin's) is one more choice, with the folder it is made
 * from and the provider's own fields: an array of names as favourite chips (ticked on every
 * start), a list of choices as pills, anything else as text. Saved as `metadata.workspace_source`
 * (server: core/workspaces/project-source.ts checks it). A legacy project (default folder +
 * isolated workspace on) reads as its own checked choice ("Workspace setting") with a button to make
 * it an explicit git worktree source; a source with no folder to be made from cannot be saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { saveProjectMetadata, type ProjectMetadata, type WorkspaceSource } from '@/api/projects';
import { fetchWorkspaceCandidates, type WorkspaceCandidate } from '@/api/workspaces';
import { refreshProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { log } from '@/utils/log';
import { Checkbox, Chip, ChipGroup } from '@/components/controls';
import '@/styles/project-start.css';

const FOLDER = '';

/** The catalog, read once per page: the providers need no folder and no host to be listed. */
let catalog: Promise<WorkspaceCandidate[]> | null = null;
function providerCatalog(): Promise<WorkspaceCandidate[]> {
  catalog ??= fetchWorkspaceCandidates('', null).then((a) => a.candidates, (err) => { catalog = null; throw err; });
  return catalog;
}

function sameSource(a: WorkspaceSource | null, b: WorkspaceSource | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function ProjectCodeSource({ project, metadata, row, onSaved }: {
  project: string;
  metadata: ProjectMetadata;
  row: ProjectRegistryRow | null;
  onSaved: (merged: ProjectMetadata) => void;
}) {
  const stored = metadata.workspace_source && typeof metadata.workspace_source.provider === 'string' ? metadata.workspace_source : null;
  const legacy = !stored && row?.startSource?.provider === 'auto';
  const [providers, setProviders] = useState<WorkspaceCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<WorkspaceSource | null>(stored);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const storedKey = JSON.stringify(stored);
  // A save elsewhere (another tab, an agent) moves the stored value: the form follows it.
  useEffect(() => { setEdit(stored); setSaveError(null); }, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    providerCatalog().then((list) => { if (alive) setProviders(list); }, (err) => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, []);

  const picked = edit?.provider ?? FOLDER;
  const info = providers?.find((p) => p.provider === picked);
  const fields = useMemo(() => Object.entries(info?.inputSchema?.properties ?? {}), [info]);
  const dirty = !sameSource(edit, stored);
  // A legacy project reads as its own choice ("Workspace setting"), never as Folder.
  const onLegacy = legacy && !edit;
  // A source needs a folder to be made from: its own, else the project's Working Dir.
  const needsAnchor = !!edit && !edit.anchor?.trim() && !row?.defaultCwd;

  const save = async (next: WorkspaceSource | null) => {
    setSaving(true);
    setSaveError(null);
    try {
      const merged = await saveProjectMetadata(project, { workspace_source: next ? clean(next) : null });
      onSaved(merged);
      refreshProjectRegistry();
      log.info('project', 'code source saved', { project, provider: next?.provider ?? 'folder' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const setInput = (key: string, value: unknown) => setEdit((e) => (e ? { ...e, inputs: { ...e.inputs, [key]: value } } : e));

  return (
    <div className="detail-section project-code-source" data-testid="project-code-source">
      <div className="detail-section-title">Code source</div>
      <div className="pcs-note">Where a new task of this project gets its code. With a source, every start makes a fresh workspace from it, removed once the task is done and its work is merged.</div>
      {legacy && !dirty && (
        <div className="pcs-legacy" data-testid="project-code-source-legacy">
          <span>A fresh isolated workspace of {row?.startSource?.anchor} <span className="pcs-note">(from the project's Workspace setting)</span></span>
          <div className="pcs-actions">
            <button type="button" className="pcs-choice" data-testid="project-code-source-make-explicit" disabled={saving}
              onClick={() => { void save({ provider: 'git-worktree', ...(row?.defaultCwd ? { anchor: row.defaultCwd } : {}) }); }}>
              Make it a git worktree source
            </button>
          </div>
        </div>
      )}
      <ChipGroup className="pcs-choices" role="radiogroup" aria-label="Code source">
        <Chip role="radio" pressed={picked === FOLDER && !onLegacy} data-testid="project-code-source-folder"
          onClick={() => setEdit(null)}
          // A legacy project leaves the folder flow through its Workspace setting, not here.
          disabled={legacy}
          title={legacy ? 'To start in a folder, turn off the isolated workspace in this project\'s Workspace setting' : 'A new task starts in a folder you pick (today\'s way)'}>
          Folder
        </Chip>
        {legacy && (
          <Chip role="radio" pressed={onLegacy} data-testid="project-code-source-auto"
            onClick={() => setEdit(null)}
            title="Each start makes an isolated workspace of the Working Dir, by the project's Workspace setting">
            Workspace setting
          </Chip>
        )}
        {(providers ?? []).map((p) => (
          <Chip key={p.provider} role="radio" pressed={picked === p.provider}
            data-testid={`project-code-source-${p.provider}`}
            onClick={() => setEdit((e) => ({ provider: p.provider, ...(e?.anchor ? { anchor: e.anchor } : {}), inputs: e?.provider === p.provider ? e.inputs ?? {} : {} }))}>
            {p.displayName}
          </Chip>
        ))}
      </ChipGroup>
      {!providers && !loadError && <div className="pcs-note">Loading the workspace kinds…</div>}
      {loadError && <div className="pcs-note is-error">{loadError}</div>}
      {edit && (
        <>
          <label className="pcs-field">
            <span className="pcs-field-label">Made from</span>
            <input className="pcs-input" data-no-draft="autosave" data-testid="project-code-source-anchor"
              value={edit.anchor ?? ''} placeholder={row?.defaultCwd ? `${row.defaultCwd} (the Working Dir)` : '/path/to/a/checkout'}
              onChange={(e) => setEdit({ ...edit, anchor: e.target.value })} />
          </label>
          {fields.map(([key, field]) => (
            <InputField key={key} name={key} field={field} value={edit.inputs?.[key]} onChange={(v) => setInput(key, v)} />
          ))}
        </>
      )}
      {(dirty || saveError) && (
        <div className="pcs-actions">
          <button type="button" className="pcs-save" data-testid="project-code-source-save" disabled={saving || !dirty || needsAnchor} onClick={() => { void save(edit); }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="pcs-choice" disabled={saving} onClick={() => { setEdit(stored); setSaveError(null); }}>Cancel</button>
        </div>
      )}
      {dirty && needsAnchor && (
        <div className="pcs-note is-error" data-testid="project-code-source-needs-folder">
          Add the folder it is made from: this project has no Working Dir to make it from.
        </div>
      )}
      {saveError && <div className="pcs-note is-error" data-testid="project-code-source-error">{saveError}</div>}
    </div>
  );
}

type Field = NonNullable<NonNullable<WorkspaceCandidate['inputSchema']>['properties']>[string];

function InputField({ name, field, value, onChange }: { name: string; field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [typed, setTyped] = useState('');
  const title = field.title ?? name;
  if (field.type === 'array') {
    const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const add = () => {
      const names = typed.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s && !list.includes(s));
      if (names.length) onChange([...list, ...names]);
      setTyped('');
    };
    return (
      <div className="pcs-field" data-testid={`project-code-source-field-${name}`}>
        <span className="pcs-field-label">{title}: favourites, ticked on every start</span>
        <div className="pcs-chips">
          {list.map((v) => (
            <span key={v} className="draft-source-value" data-testid="project-code-source-value">
              <span className="draft-source-star" aria-hidden>★</span>
              <span className="draft-source-value-name">{v}</span>
              <button type="button" className="draft-source-remove" aria-label={`Remove ${v}`} onClick={() => onChange(list.filter((x) => x !== v))}>×</button>
            </span>
          ))}
          <input className="pcs-input" data-no-draft="autosave" data-testid={`project-code-source-add-${name}`}
            placeholder={field.placeholder ? `Add, e.g. ${field.placeholder}` : 'Add a name'} value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            onBlur={add} />
        </div>
      </div>
    );
  }
  if (field.type === 'string' && field.enum?.length) {
    const current = typeof value === 'string' ? value : (field.default as string | undefined);
    return (
      <div className="pcs-field">
        <span className="pcs-field-label">{title}</span>
        <ChipGroup className="pcs-choices" role="radiogroup" aria-label={title}>
          {field.enum.map((opt) => (
            <Chip key={opt} role="radio" pressed={current === opt} onClick={() => onChange(opt)}>{opt}</Chip>
          ))}
        </ChipGroup>
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <div className="pcs-field">
        {/* A field of a form that waits for Save: a checkbox (standard.md, "Choice controls"). */}
        <Checkbox checked={value === true} label={title} title={field.description} onChange={(on) => onChange(on)} />
      </div>
    );
  }
  return (
    <label className="pcs-field" title={field.description}>
      <span className="pcs-field-label">{title}</span>
      <input className="pcs-input" data-no-draft="autosave" value={typeof value === 'string' ? value : ''} placeholder={field.placeholder ?? ''}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** What is stored: no empty folder, no empty field. */
function clean(src: WorkspaceSource): WorkspaceSource {
  const inputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src.inputs ?? {})) {
    if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
    inputs[k] = typeof v === 'string' ? v.trim() : v;
  }
  const anchor = src.anchor?.trim();
  return { provider: src.provider, ...(anchor ? { anchor } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
}
