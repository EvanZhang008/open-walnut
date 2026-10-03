/**
 * The body of the draft's "Isolated workspace" option, above the folder row.
 *
 * The switch itself is a row of the draft's More menu (DraftWorkspaceMenuItem).
 * While it is OFF this renders NOTHING, so a folder pick adds nothing to the
 * bottom-anchored bar and the quick folder chips never move under the pointer.
 * Turned on, it asks the folder's host which providers can isolate the folder
 * (the ONLY network call here, and only on that click or a folder change while
 * on), shows them as a row of pills (git-worktree when the folder is a git
 * repository; plugin providers, a match first), and the picked provider's own
 * fields, led by a quiet "Isolated workspace ✓" pill whose × turns it off. The
 * launch reads the choice at Start (draftWorkspaceRequest).
 *
 * Plain controls only: pills and text inputs, no native <select>, no overlay.
 */
import { useEffect, useId } from 'react';
import { fetchWorkspaceCandidates } from '@/api/workspaces';
import { log } from '@/utils/log';
import {
  isPickable, selectedCandidate, setDraftWorkspace, useDraftWorkspace, getDraftWorkspace,
} from './draft-workspace-store';
import '@/styles/workspaces.css';

export function DraftWorkspaceRow({ draftId, cwd, host }: { draftId: string; cwd?: string; host?: string | null }) {
  const choice = useDraftWorkspace(draftId);
  const fieldIdBase = useId();
  const place = cwd ? `${host ?? ''}::${cwd}` : '';

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

  if (!cwd || !choice.enabled) return null;
  const picked = selectedCandidate(choice);
  const pickable = (choice.candidates ?? []).filter(isPickable);
  const unpickable = (choice.candidates ?? []).filter((c) => !isPickable(c));
  const fields = picked && isPickable(picked) ? Object.entries(picked.inputSchema?.properties ?? {}) : [];
  const required = new Set(picked?.inputSchema?.required ?? []);

  return (
    <div className="draft-workspace-row is-on" data-testid="draft-workspace-row">
      <div className="draft-workspace-body">
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
                onClick={() => setDraftWorkspace(draftId, { values: { ...choice.values, [key]: value !== true } })}
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
                    onClick={() => setDraftWorkspace(draftId, { values: { ...choice.values, [key]: opt } })}
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
                className="draft-workspace-input"
                data-testid={`draft-workspace-input-${key}`}
                value={typeof value === 'string' ? value : ''}
                placeholder={field.placeholder ?? (field.type === 'array' ? 'names, separated by commas' : '')}
                onChange={(e) => setDraftWorkspace(draftId, { values: { ...choice.values, [key]: e.target.value } })}
                // The composer owns Enter; a field must not start the launch half-filled.
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              />
            </label>
          );
        })}
        {choice.startError && <span className="draft-workspace-note is-error" data-testid="draft-workspace-start-error">{choice.startError}</span>}
      </div>
    </div>
  );
}
