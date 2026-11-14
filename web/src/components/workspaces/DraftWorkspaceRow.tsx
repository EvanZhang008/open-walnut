/**
 * The draft's "Isolated workspace" option, above the folder row.
 *
 * A NEW draft's switch is a row of its More menu (DraftWorkspaceMenuItem). While
 * it is off this renders NOTHING, so a folder pick adds nothing to the
 * bottom-anchored bar and the quick folder chips never move under the pointer.
 * On, the body leads with a quiet "Isolated workspace ✓" pill whose × turns it off.
 *
 * A BOUND draft (the ▶ Start of an existing task) has no More menu, so it keeps
 * the quiet inline toggle, off by default. Only when it opened knowing its
 * folder: that is decided once, at mount, so the row is there from the first
 * paint and a folder that arrives later never inserts it. A task that already
 * has a workspace row gets no option: a ready or kept workspace is where its
 * sessions run, and the next start makes any other one again on its own.
 *
 * Turned on, it asks the folder's host which providers can isolate the folder
 * (the ONLY network call here, and only on that click or a folder change while
 * on), shows them as a row of pills (git-worktree when the folder is a git
 * repository; plugin providers, a match first), and the picked provider's own
 * fields. The launch reads the choice at Start (draftWorkspaceRequest).
 *
 * Plain controls only: pills and text inputs, no native <select>, no overlay.
 */
import { useEffect, useId, useState } from 'react';
import { useStoreTask } from '@/contexts/TasksContext';
import { allowScriptsFile, fetchScripts, fetchWorkspaceCandidates, type ResolvedProjectScript } from '@/api/workspaces';
import { log } from '@/utils/log';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import {
  isPickable, selectedCandidate, setDraftWorkspace, useDraftWorkspace, getDraftWorkspace,
  type DraftWorkspaceChoice,
} from './draft-workspace-store';
import '@/styles/workspaces.css';

export function DraftWorkspaceRow({ draftId, cwd, host, boundTaskId, project }: {
  draftId: string; cwd?: string; host?: string | null;
  /** The existing task a bound draft starts (it has no More menu). */
  boundTaskId?: string;
  /** The project the task goes to: its setup script is the one that runs. */
  project?: string;
}) {
  const choice = useDraftWorkspace(draftId);
  const bound = !!boundTaskId;
  const boundTask = useStoreTask(boundTaskId);
  // Decided at mount (see the header): never inserted after the first paint.
  const [inlineAtMount] = useState(() => bound && !!cwd && !boundTask?.workspace);
  const inline = inlineAtMount && !boundTask?.workspace;
  const fieldIdBase = useId();
  const place = cwd ? `${host ?? ''}::${cwd}` : '';

  // The provider fields typed for this draft are also kept in the draft store: the
  // choice itself lives in memory (draft-workspace-store.ts), so after a reload the
  // kept values are put back into it.
  const kept = useDraftValue<DraftWorkspaceChoice['values']>(draftKey('draft-workspace', draftId), {});
  const keptValues = kept.value;
  useEffect(() => {
    if (Object.keys(keptValues).length && !Object.keys(getDraftWorkspace(draftId).values).length) {
      setDraftWorkspace(draftId, { values: keptValues });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);
  const setValues = (values: DraftWorkspaceChoice['values']) => {
    setDraftWorkspace(draftId, { values });
    kept.setValue(values);
  };

  // Ask the host when the option is on and the folder is new to this choice.
  // No cleanup guard on purpose: writing `candidatesFor` re-runs this effect, and
  // a cleanup would drop the answer to the request it just sent. The answer is
  // matched to the folder it was asked about instead.
  useEffect(() => {
    if (!choice.enabled || !cwd || choice.candidatesFor === place) return;
    setDraftWorkspace(draftId, { loading: true, candidatesFor: place, error: undefined });
    fetchWorkspaceCandidates(cwd, host).then((answer) => {
      if (getDraftWorkspace(draftId).candidatesFor !== place) return;
      const cur = getDraftWorkspace(draftId);
      const keep = cur.provider && answer.candidates.some((c) => c.provider === cur.provider && isPickable(c)) ? cur.provider : undefined;
      const best = answer.candidates.find((c) => c.claimed);
      setDraftWorkspace(draftId, {
        loading: false, candidates: answer.candidates, degraded: answer.degraded,
        provider: keep ?? best?.provider,
      });
      log.info('workspace', 'draft providers answered', {
        draftId, cwd, host: host ?? '__local__', providers: answer.candidates.map((c) => `${c.provider}:${c.claimed ? 'claimed' : 'no'}`).join(','),
        degraded: answer.degraded,
      });
    }, (err) => {
      if (getDraftWorkspace(draftId).candidatesFor !== place) return;
      setDraftWorkspace(draftId, { loading: false, candidates: [], error: err instanceof Error ? err.message : String(err) });
    });
  }, [choice.enabled, cwd, host, place, choice.candidatesFor, draftId]);

  // The setup script the new workspace will run (scripts.ts), said before Start.
  // A walnut.json the user has not allowed yet does not run by itself: the
  // notice says so and allows it in one click.
  type SetupView = { place: string; script: ResolvedProjectScript | null; needsOk: boolean; key?: string; unavailable?: string };
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [allowing, setAllowing] = useState(false);
  const [allowError, setAllowError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [reload, setReload] = useState(0);
  // The worktree starts from the folder's commit (or the base branch typed): its walnut.json, as committed.
  const typedBase = typeof choice.values.baseRef === 'string' ? choice.values.baseRef.trim() : '';
  const baseRef = choice.provider === 'git-worktree' && typedBase ? typedBase : 'HEAD';
  const setupPlace = `${place}::${project ?? boundTask?.project ?? ''}::${baseRef}`;
  useEffect(() => {
    if (!choice.enabled || !cwd) return;
    let alive = true;
    fetchScripts({ cwd, host: host ?? undefined, project: project ?? boundTask?.project, ref: baseRef }).then((v) => {
      if (!alive) return;
      const script = v.scripts.find((s) => s.id === v.setup) ?? null;
      setSetup({ place: setupPlace, script, needsOk: !!script && script.source !== 'project' && !v.file_trusted, key: v.file?.key, unavailable: v.file_unavailable });
    }, () => { if (alive) setSetup({ place: setupPlace, script: null, needsOk: false }); });
    return () => { alive = false; };
  }, [choice.enabled, cwd, host, project, boundTask?.project, baseRef, setupPlace, reload]);
  const shownSetup = setup?.place === setupPlace ? setup : null;
  const setupScript = shownSetup?.script ?? null;
  const allow = async () => {
    if (!shownSetup?.key) return;
    setAllowing(true);
    setAllowError(null);
    try {
      await allowScriptsFile(shownSetup.key);
      log.info('workspace', 'draft allowed the repository scripts file', { draftId, cwd });
      setReload((n) => n + 1);
    } catch (err) {
      setAllowError(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowing(false);
    }
  };

  if (!cwd || (bound ? !inline : !choice.enabled)) return null;
  const picked = selectedCandidate(choice);
  const pickable = (choice.candidates ?? []).filter(isPickable);
  const unpickable = (choice.candidates ?? []).filter((c) => !isPickable(c));
  const fields = picked && isPickable(picked) ? Object.entries(picked.inputSchema?.properties ?? {}) : [];
  const required = new Set(picked?.inputSchema?.required ?? []);

  return (
    <div className={`draft-workspace-row${choice.enabled ? ' is-on' : ''}`} data-testid="draft-workspace-row">
      {bound && (
        <button
          type="button"
          className={`draft-workspace-toggle${choice.enabled ? ' is-on' : ''}`}
          aria-pressed={choice.enabled}
          data-testid="draft-workspace-toggle"
          title={choice.enabled
            ? 'The task gets its own working copy; its session starts there once it is ready'
            : 'Give this task its own working copy (a git worktree, or a plugin workspace)'}
          onClick={() => {
            setDraftWorkspace(draftId, { enabled: !choice.enabled });
            log.info('workspace', 'draft option toggled', { draftId, enabled: !choice.enabled, via: 'bound-toggle' });
          }}
        >
          <span className="draft-workspace-check" aria-hidden>{choice.enabled ? '✓' : ''}</span>
          Isolated workspace
        </button>
      )}
      {choice.enabled && (
        <div className="draft-workspace-body">
          {!bound && (
            <span className="draft-workspace-on" data-testid="draft-workspace-on" title="The task gets its own working copy; its session starts there once it is ready">
              Isolated workspace ✓
              <button
                type="button"
                className="draft-workspace-off"
                data-testid="draft-workspace-off"
                aria-label="Turn off the isolated workspace"
                title="Turn off: run in the folder itself"
                onClick={() => {
                  setDraftWorkspace(draftId, { enabled: false });
                  log.info('workspace', 'draft option toggled', { draftId, enabled: false, via: 'body-pill' });
                }}
              >
                ×
              </button>
            </span>
          )}
          {choice.loading && <span className="draft-workspace-note" data-testid="draft-workspace-loading">Checking this folder…</span>}
          {!choice.loading && choice.error && <span className="draft-workspace-note is-error">{choice.error}</span>}
          {!choice.loading && pickable.length > 0 && (
            <div className="draft-workspace-providers" role="radiogroup" aria-label="Workspace provider">
              {pickable.map((c) => (
                <button
                  key={c.provider}
                  type="button"
                  role="radio"
                  aria-checked={picked?.provider === c.provider}
                  className={`draft-workspace-provider${picked?.provider === c.provider ? ' is-picked' : ''}`}
                  data-testid={`draft-workspace-provider-${c.provider}`}
                  title={c.claimed ? (c.root ? `Matches ${c.root}` : 'Matches this folder') : (c.reason ?? 'Pick it to use it here')}
                  onClick={() => setDraftWorkspace(draftId, { provider: c.provider })}
                >
                  {c.displayName}
                  {c.claimed && c.branch && <span className="draft-workspace-provider-meta"> · from {c.branch}</span>}
                </button>
              ))}
            </div>
          )}
          {!choice.loading && pickable.length === 0 && !choice.error && (
            <span className="draft-workspace-note is-warn" data-testid="draft-workspace-none">
              {unpickable[0]?.reason ? `No way to isolate this folder: ${unpickable[0].reason}` : 'No way to isolate this folder'}
            </span>
          )}
          {!choice.loading && choice.degraded && pickable.length > 0 && unpickable[0]?.reason && (
            <span className="draft-workspace-note">{unpickable[0].reason}</span>
          )}
          {fields.map(([key, field], i) => {
            const id = `${fieldIdBase}-${i}`;
            const value = choice.values[key];
            const label = `${field.title ?? key}${required.has(key) ? '' : ' (optional)'}`;
            if (field.type === 'boolean') {
              return (
                <button
                  key={key}
                  type="button"
                  className={`draft-workspace-provider${value === true ? ' is-picked' : ''}`}
                  aria-pressed={value === true}
                  title={field.description}
                  onClick={() => setValues({ ...choice.values, [key]: value !== true })}
                >
                  {field.title ?? key}
                </button>
              );
            }
            if (field.type === 'string' && field.enum?.length) {
              return (
                <div key={key} className="draft-workspace-field" role="radiogroup" aria-label={field.title ?? key}>
                  <span className="draft-workspace-field-label">{label}</span>
                  {field.enum.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={(value ?? field.default) === opt}
                      className={`draft-workspace-provider${(value ?? field.default) === opt ? ' is-picked' : ''}`}
                      onClick={() => setValues({ ...choice.values, [key]: opt })}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              );
            }
            return (
              <label key={key} className="draft-workspace-field" htmlFor={id} title={field.description}>
                <span className="draft-workspace-field-label">{label}</span>
                <input
                  id={id}
                  data-draft-key={kept.key ?? undefined}
                  className="draft-workspace-input"
                  data-testid={`draft-workspace-input-${key}`}
                  value={typeof value === 'string' ? value : ''}
                  // "current commit" beside "from main" read as two bases: say they are the same one.
                  placeholder={field.placeholder === 'current commit' && picked?.claimed && picked.branch ? `current commit of ${picked.branch}`
                    : field.placeholder ?? (field.type === 'array' ? 'names, separated by commas' : '')}
                  onChange={(e) => setValues({ ...choice.values, [key]: e.target.value })}
                  // The composer owns Enter; a field must not start the launch half-filled.
                  onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                />
              </label>
            );
          })}
          {setupScript && picked && isPickable(picked) && (
            <span className={`draft-workspace-note draft-workspace-setup${shownSetup?.needsOk ? ' needs-ok' : ''}`} data-testid="draft-workspace-setup"
              data-needs-ok={shownSetup?.needsOk ? '' : undefined}
              title={`${setupScript.command}\nFrom the ${setupScript.source === 'project' ? "project's scripts" : setupScript.source}`}>
              {shownSetup?.needsOk ? (
                <span className="draft-workspace-setup-lead">
                  Setup <strong>{setupScript.name}</strong> from {setupScript.source} is new here: it runs only once you allow it
                  <button type="button" className="draft-workspace-allow" onClick={() => { void allow(); }} disabled={allowing} data-testid="draft-workspace-allow"
                    title={`Let this ${setupScript.source} run its setup and cleanup by itself until it changes`}>
                    {allowing ? 'Allowing…' : 'Allow setup'}
                  </button>
                </span>
              ) : (
                <span className="draft-workspace-setup-lead">
                  Then runs setup <strong>{setupScript.name}</strong>{setupScript.wait === false ? ' (the session does not wait for it)' : '; the session starts once it ends'}
                </span>
              )}
              <code
                className={commandOpen ? 'is-open' : setupScript.command.length > 48 || setupScript.command.includes('\n') ? 'is-long' : undefined}
                onClick={() => setCommandOpen((v) => !v)} data-testid="draft-workspace-setup-command">
                {setupScript.command}
              </code>
            </span>
          )}
          {!setupScript && shownSetup?.unavailable && picked && isPickable(picked) && (
            // A host that cannot read the repository's walnut.json (an older daemon, offline): no setup will run, say why.
            <span className="draft-workspace-note is-warn" data-testid="draft-workspace-setup-unavailable">
              No setup will run: the repository's walnut.json could not be read. {shownSetup.unavailable}
            </span>
          )}
          {allowError && <span className="draft-workspace-note is-error">{allowError}</span>}
          {choice.startError && <span className="draft-workspace-note is-error" data-testid="draft-workspace-start-error">{choice.startError}</span>}
        </div>
      )}
    </div>
  );
}
