/**
 * The editor of a project's scripts (src/core/workspaces/scripts.ts): its own
 * list, editable, and the repository's walnut.json, read-only beside it.
 *
 * Every add, edit and delete saves the whole list at once (the server checks
 * it: unique names, one setup, one teardown) and the dialog shows the stored
 * form, so what is on screen is what is saved. Escape while a script is being
 * edited cancels that edit first, never the typed command.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useConfirm } from '@/hooks/useConfirm';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { focusUnlessTyping } from '@/utils/focus-unless-typing';
import { ScriptCommand } from './ScriptCommand';
import { allowScriptsFile, fetchScripts, saveProjectScripts, type ProjectScript, type ScriptsAnswer } from '@/api/workspaces';
import { log } from '@/utils/log';
import '@/styles/workspaces.css';

/** `timeout_sec` has no field here (the API sets it); an edit keeps it. */
type Draft = { id?: string; name: string; command: string; setup: boolean; wait: boolean; teardown: boolean; timeout_sec?: number };
const EMPTY: Draft = { name: '', command: '', setup: false, wait: true, teardown: false };

function toDraft(s: ProjectScript): Draft {
  return { id: s.id, name: s.name, command: s.command, setup: !!s.setup, wait: s.wait !== false, teardown: !!s.teardown, ...(s.timeout_sec ? { timeout_sec: s.timeout_sec } : {}) };
}

function fromDraft(d: Draft): Omit<ProjectScript, 'id'> & { id?: string } {
  return {
    ...(d.id ? { id: d.id } : {}), name: d.name.trim(), command: d.command.trim(),
    ...(d.setup ? { setup: true, ...(d.wait ? {} : { wait: false }) } : {}),
    ...(d.teardown ? { teardown: true } : {}),
    ...(d.timeout_sec ? { timeout_sec: d.timeout_sec } : {}),
  };
}

/**
 * The roles of a script, in a few words. `replaced` names a role another
 * script plays instead (the project's own wins over the file's).
 */
export function scriptRoles(s: { setup?: boolean; wait?: boolean; teardown?: boolean }, replaced: { setup?: boolean; teardown?: boolean } = {}): string[] {
  const out: string[] = [];
  if (s.setup) out.push(replaced.setup ? 'Setup (replaced by the project\'s)' : s.wait === false ? 'Setup (does not wait)' : 'Setup');
  if (s.teardown) out.push(replaced.teardown ? 'On complete (replaced by the project\'s)' : 'On complete');
  return out;
}

function Roles({ s, replaced }: { s: { setup?: boolean; wait?: boolean; teardown?: boolean }; replaced?: { setup?: boolean; teardown?: boolean } }) {
  const roles = scriptRoles(s, replaced);
  if (!roles.length) return null;
  return <span className="project-scripts-roles">{roles.map((r) => <span key={r} className={`project-scripts-role${/replaced/.test(r) ? ' is-replaced' : ''}`}>{r}</span>)}</span>;
}

export function ProjectScriptsDialog({ project, cwd, host, onClose, onSaved }: {
  project: string;
  /** The folder whose walnut.json is shown (default: the project's own folder). */
  cwd?: string;
  host?: string | null;
  onClose: () => void;
  onSaved?: (scripts: ProjectScript[]) => void;
}) {
  const [answer, setAnswer] = useState<ScriptsAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [list, setList] = useState<ProjectScript[]>([]);
  // The open form (a script's edit, or a new one); its fields are a draft kept across
  // a reload or a closed dialog until Save or Cancel.
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const editedSaved = editing?.id ? list.find((x) => x.id === editing.id) : undefined;
  const formBase = editedSaved ? toDraft(editedSaved) : EMPTY;
  const kept = useDraftValue<Draft>(editing ? draftKey('project-script', project, editing.id ?? 'new') : null, formBase);
  const draft: Draft | null = editing ? { ...formBase, ...kept.value, ...(editing.id ? { id: editing.id } : {}) } : null;
  const keptRef = useRef(kept);
  keptRef.current = kept;
  /** Open a form (its draft, if one was kept), change its fields, or close it (null: the draft goes). */
  const setDraft = useCallback((next: Draft | null) => {
    if (!next) { keptRef.current.clear(); setEditing(null); return; }
    keptRef.current.setValue(next);
  }, []);
  const openForm = useCallback((id?: string) => setEditing(id ? { id } : {}), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The field the error is about: outlined until it is edited. */
  const [badField, setBadField] = useState<'name' | 'command' | null>(null);
  const [allowing, setAllowing] = useState(false);
  const confirm = useConfirm();
  const nameRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const listRef = useRef(list);
  listRef.current = list;
  const asking = useRef(false);

  // Escape cancels an edit in progress before it closes the dialog; one with typed
  // changes asks first, so a stray key never throws them away.
  useModalOverlay(useCallback(() => {
    const d = draftRef.current;
    if (!d) { onClose(); return; }
    const saved = d.id ? listRef.current.find((x) => x.id === d.id) : undefined;
    const base = saved ? toDraft(saved) : EMPTY;
    const reset = () => { setDraft(null); setError(null); setBadField(null); };
    const same = d.name.trim() === base.name.trim() && d.command.trim() === base.command.trim()
      && d.setup === base.setup && d.wait === base.wait && d.teardown === base.teardown;
    if (same) { reset(); return; }
    if (asking.current) return;
    asking.current = true;
    void confirm({ title: d.id ? 'Discard your changes to this script?' : 'Discard this new script?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
      .then((ok) => { if (ok) reset(); })
      .finally(() => { asking.current = false; });
  }, [onClose, confirm]));

  useEffect(() => {
    let alive = true;
    fetchScripts({ project, ...(cwd ? { cwd } : {}), ...(host ? { host } : {}) }).then((v) => {
      if (!alive) return;
      setAnswer(v);
      setList(v.scripts.filter((s) => s.source === 'project').map(({ source: _s, ...rest }) => rest));
    }, (err) => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [project, cwd, host]);

  useEffect(() => {
    // Not over a field the person already went to (the command, say).
    if (draft) setTimeout(() => focusUnlessTyping(nameRef.current), 10);
  }, [draft?.id, !!draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (next: Array<Omit<ProjectScript, 'id'> & { id?: string }>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await saveProjectScripts(project, next);
      setList(res.scripts);
      onSaved?.(res.scripts);
      log.info('workspace', 'project scripts saved', { project, count: res.scripts.length });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [project, onSaved]);

  const submit = useCallback(async () => {
    if (!draft) return;
    setBadField(null);
    if (!draft.name.trim()) { setError('Give the script a name.'); setBadField('name'); nameRef.current?.focus(); return; }
    if (!draft.command.trim()) { setError('Give the script a command.'); setBadField('command'); commandRef.current?.focus(); return; }
    const clash = list.find((s) => s.id !== draft.id && s.name.toLowerCase() === draft.name.trim().toLowerCase());
    // The field's own hint already says so (projectClash): no second line for it.
    if (clash) { setBadField('name'); nameRef.current?.select(); return; }
    // One setup and one teardown script: picking the role here moves it from another.
    const others = list.filter((s) => s.id !== draft.id).map((s) => ({
      ...s,
      ...(draft.setup && s.setup ? { setup: undefined, wait: undefined } : {}),
      ...(draft.teardown && s.teardown ? { teardown: undefined } : {}),
    }));
    const edited = fromDraft(draft);
    const next = draft.id ? list.map((s) => (s.id === draft.id ? edited : others.find((o) => o.id === s.id)!)) : [...others, edited];
    if (await save(next)) setDraft(null);
  }, [draft, list, save]);

  const remove = useCallback(async (s: ProjectScript) => {
    const ok = await confirm({ title: `Delete the script "${s.name}"?`, message: s.command, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    if (await save(list.filter((x) => x.id !== s.id)) && draft?.id === s.id) setDraft(null);
  }, [confirm, save, list, draft?.id]);

  const allowFile = useCallback(async () => {
    const key = answer?.file?.key;
    if (!key) return;
    setAllowing(true);
    setError(null);
    try {
      await allowScriptsFile(key);
      setAnswer((v) => (v ? { ...v, file_trusted: true } : v));
      log.info('workspace', 'repository scripts file allowed', { project, file: answer?.file?.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowing(false);
    }
  }, [answer?.file?.key, answer?.file?.path, project]);

  const fileScripts = answer?.scripts.filter((s) => s.source !== 'project') ?? [];
  const fileRuns = fileScripts.some((s) => s.setup || s.teardown);
  const setupOwner = list.find((s) => s.setup && s.id !== draft?.id);
  const teardownOwner = list.find((s) => s.teardown && s.id !== draft?.id);

  const fileSetup = fileScripts.find((s) => s.setup);
  const fileTeardown = fileScripts.find((s) => s.teardown);
  const fileName = answer?.file?.name ?? 'walnut.json';
  // Another project script of this name: saving is refused, so nothing would replace the file's.
  const projectClash = draft && draft.name.trim() ? list.find((s) => s.id !== draft.id && s.name.trim().toLowerCase() === draft.name.trim().toLowerCase()) : undefined;
  const fileTwin = draft && !projectClash ? fileScripts.find((s) => s.name.trim().toLowerCase() === draft.name.trim().toLowerCase() && !!draft.name.trim()) : undefined;
  // Saving takes the file's script over only when this one did not already (a rename onto it, or a new one).
  // Save waits for a name, a command and a name no other project script has (the fields say which).
  const noName = !!draft && !draft.name.trim();
  const noCommand = !!draft && !draft.command.trim();
  const saveBlocked = !draft ? '' : noName && noCommand ? 'Add a name and a command to save it' : noName ? 'Add a name to save it' : noCommand ? 'Add a command to save it' : projectClash ? 'Another script of this project has this name' : '';
  const draftReady = !!draft && !saveBlocked;
  const takesOver = !!fileTwin && !(draft?.id && list.find((p) => p.id === draft.id)?.name.toLowerCase() === fileTwin.name.toLowerCase());

  const form = draft && (
          <form className="project-scripts-form" data-testid="project-script-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <label className="project-scripts-field">
              <span>Name</span>
              <input ref={nameRef} className="app-modal-input" data-draft-key={kept.key ?? undefined} value={draft.name} maxLength={60} placeholder="e.g. Dev server" onChange={(e) => { setDraft({ ...draft, name: e.target.value }); if (badField === 'name') { setBadField(null); setError(null); } }} data-testid="project-script-name"
                aria-invalid={badField === 'name' || undefined} />
              {projectClash && <small className="project-scripts-field-hint is-warn" data-testid="project-script-name-clash">
                This project already has a script named "{projectClash.name}": give this one another name.
              </small>}
              {fileTwin && <small className="project-scripts-field-hint is-warn" data-testid="project-script-name-twin">
                {answer?.file?.name ?? 'walnut.json'} in the repository has a "{fileTwin.name}" too ({fileTwin.command}). Saving this one replaces it in every session's Scripts menu.
              </small>}
            </label>
            <label className="project-scripts-field">
              <span>Command</span>
              <textarea
                ref={commandRef} className="app-modal-input project-scripts-textarea" data-draft-key={kept.key ?? undefined} value={draft.command} rows={3} maxLength={4000} spellCheck={false}
                placeholder="bun run dev" onChange={(e) => { setDraft({ ...draft, command: e.target.value }); if (badField === 'command') { setBadField(null); setError(null); } }} data-testid="project-script-command"
                aria-invalid={badField === 'command' || undefined}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
              />
            </label>
            <div className="project-scripts-check">
              <input id="project-script-setup" type="checkbox" checked={draft.setup} onChange={(e) => setDraft({ ...draft, setup: e.target.checked })} data-testid="project-script-setup" aria-describedby="project-script-setup-hint" />
              <span>
                <label htmlFor="project-script-setup">Run when a new isolated workspace is made</label>
                <small id="project-script-setup-hint">{setupOwner && draft.setup ? `Takes this over from "${setupOwner.name}".`
                  : fileSetup && draft.setup && fileSetup.name.trim().toLowerCase() !== draft.name.trim().toLowerCase() ? `Runs instead of ${fileName}'s setup "${fileSetup.name}" in new workspaces.`
                  : 'For example: install dependencies, copy .env from $WALNUT_SOURCE_REPO. List the files it makes in .gitignore: a workspace with new files is kept when its task completes.'}</small>
              </span>
            </div>
            {draft.setup && (
              <label className="project-scripts-check is-nested">
                <input type="checkbox" checked={draft.wait} onChange={(e) => setDraft({ ...draft, wait: e.target.checked })} data-testid="project-script-wait" />
                <span>
                  The first session waits until it finishes
                  <small>{draft.wait ? 'The session starts once setup ends, so what it installs is there.' : 'The session starts at once; setup runs beside it.'}</small>
                </span>
              </label>
            )}
            <div className="project-scripts-check">
              <input id="project-script-teardown" type="checkbox" checked={draft.teardown} onChange={(e) => setDraft({ ...draft, teardown: e.target.checked })} data-testid="project-script-teardown" aria-describedby="project-script-teardown-hint" />
              <span>
                <label htmlFor="project-script-teardown">Run when the task completes</label>
                <small id="project-script-teardown-hint">{teardownOwner && draft.teardown ? `Takes this over from "${teardownOwner.name}".`
                  : fileTeardown && draft.teardown && fileTeardown.name.trim().toLowerCase() !== draft.name.trim().toLowerCase() ? `Runs instead of ${fileName}'s cleanup "${fileTeardown.name}" when a task completes.`
                  : 'In its workspace, before Walnut cleans it up. For example: docker compose down.'}</small>
              </span>
            </div>
            {error && <div className="project-scripts-error" data-testid="project-scripts-error">{error}</div>}
            {saveBlocked && !projectClash && <div className="project-scripts-save-hint" data-testid="project-script-save-hint">{saveBlocked}.</div>}
            <div className="app-modal-actions">
              <button type="button" className="app-modal-btn" onClick={() => { setDraft(null); setError(null); setBadField(null); }}>Cancel</button>
              <button type="submit" className="app-modal-btn primary" disabled={saving || !draftReady} title={draftReady ? undefined : saveBlocked} data-testid="project-script-save">{saving ? 'Saving…' : takesOver ? (draft.id ? 'Save and replace' : 'Add and replace') : draft.id ? 'Save script' : 'Add script'}</button>
            </div>
          </form>
  );

  return createPortal(
    <div className="app-modal-overlay project-scripts-overlay" role="dialog" aria-modal="true" aria-label={`Scripts of ${project}`} onMouseDown={() => { if (!draftRef.current) onClose(); }}>
      <div className="app-modal project-scripts-dialog" data-testid="project-scripts-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="project-scripts-head">
          <div className="app-modal-title">Scripts · {project}</div>
          <button className="session-panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close">&times;</button>
        </div>
        <div className="project-scripts-lede">
          Commands for this project's sessions: run one from the Scripts menu in a session, into its terminal.
          A setup script also runs by itself in every new isolated workspace.
        </div>

        {loadError && <div className="project-scripts-error">{loadError}</div>}
        {!answer && !loadError && <div className="project-scripts-empty">Loading…</div>}

        {answer && (
          <div className="project-scripts-list" data-testid="project-scripts-list">
            {list.length === 0 && !draft && <div className="project-scripts-empty">No scripts yet.</div>}
            {list.map((s) => (draft?.id === s.id ? <Fragment key={s.id}>{form}</Fragment> : (
              <div key={s.id} className="project-scripts-row" data-testid="project-script-row" data-name={s.name}>
                <div className="project-scripts-row-main">
                  <span className="project-scripts-name">{s.name}</span>
                  <Roles s={s} />
                  {fileScripts.some((f) => f.name.toLowerCase() === s.name.toLowerCase()) && (
                    <span className="project-scripts-role" title={`Used instead of the "${s.name}" in ${answer.file?.name ?? 'walnut.json'}`}>Replaces {answer.file?.name ?? 'walnut.json'}'s</span>
                  )}
                  <ScriptCommand className="project-scripts-command" command={s.command} />
                </div>
                <div className="project-scripts-row-actions">
                  <button className="project-scripts-link" disabled={saving} onClick={() => { setError(null); setBadField(null); openForm(s.id); }}>Edit</button>
                  <button className="project-scripts-link is-danger" disabled={saving} onClick={() => { void remove(s); }} aria-label={`Delete ${s.name}`}>Delete</button>
                </div>
              </div>
            )))}
          </div>
        )}

        {draft && !draft.id && form}
        {!draft && error && <div className="project-scripts-error" data-testid="project-scripts-error">{error}</div>}
        {answer && !draft && (
          <button className="project-scripts-add" onClick={() => { setError(null); setBadField(null); openForm(); }} disabled={saving} data-testid="project-script-add">+ Add script</button>
        )}

        {answer && (
          <div className="project-scripts-file" data-testid="project-scripts-file">
            <div className="project-scripts-file-head">
              From the repository{answer.file ? <> · <code title={answer.file.path}>{answer.file.name}</code></> : null}
            </div>
            {answer.file?.error && <div className="project-scripts-error">{answer.file.name}: {answer.file.error}</div>}
            {answer.file?.warnings?.map((w) => <div key={w} className="project-scripts-note is-warn">{w}</div>)}
            {fileScripts.map((s) => (
              <div key={s.id} className="project-scripts-row is-file" data-testid="project-file-script-row" data-name={s.name}>
                <div className="project-scripts-row-main">
                  <span className="project-scripts-name">{s.name}</span>
                  <Roles s={s} replaced={{ setup: list.some((p) => p.setup), teardown: list.some((p) => p.teardown) }} />
                  {list.some((p) => p.name.toLowerCase() === s.name.toLowerCase()) && <span className="project-scripts-role is-replaced">Replaced by the project's</span>}
                  <ScriptCommand className="project-scripts-command" command={s.command} />
                </div>
              </div>
            ))}
            {!answer.file && !answer.file_unavailable && (
              <div className="project-scripts-note">
                {answer.dir
                  ? <>No <code>walnut.json</code> in {answer.dir}. Commit one to share scripts with every host and teammate.</>
                  : <>This project has no folder, so there is no repository file to read.</>}
              </div>
            )}
            {answer.file_unavailable && <div className="project-scripts-note is-warn">Could not read the repository's walnut.json: {answer.file_unavailable}</div>}
            {fileRuns && answer.file?.key && (answer.file_trusted ? (
              <div className="project-scripts-note" data-testid="project-scripts-file-allowed">
                You allowed this version: its setup and cleanup run in new workspaces without asking. A change to the file asks again.
              </div>
            ) : (
              <div className="project-scripts-note is-warn project-scripts-allow-row" data-testid="project-scripts-file-needs-ok">
                <span>Its setup and cleanup run only once you allow this version of the file.</span>
                <button className="project-scripts-link" onClick={() => { void allowFile(); }} disabled={allowing} data-testid="project-scripts-allow">
                  {allowing ? 'Allowing…' : 'Allow'}
                </button>
              </div>
            ))}

          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
