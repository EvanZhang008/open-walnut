import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { useRevealWhen } from './use-reveal';

interface Rule {
  id: string;
  match: { from?: string; subject?: string };
  taskId: string;
  taskTitle?: string;
  revision: string;
  enabled: boolean;
  confirmed: boolean;
  areaId?: string;
}
interface Binding { ruleId: string; revision: string; areaId: string }
interface RuleDraft { fileRevision: string; bindings: Binding[] }
interface RulesReply { rules: Rule[]; bindings: Binding[]; fileRevision: string }
interface AreasReply { areas: Array<{ id: string; name: string }> }

export function OrgRouterRules({ areaId }: { areaId: string }) {
  const [loaded, setLoaded] = useState<{ rules: RulesReply; areas: AreasReply; areaId: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const errorRef = useRevealWhen<HTMLParagraphElement>(error);
  const reload = async () => {
    const mine = ++generation.current;
    setLoading(true); setError(''); setSaved(false);
    try {
      const [rules, areas] = await Promise.all([
        apiGet<RulesReply>('/api/v1/router/rules'), apiGet<AreasReply>('/api/v1/router/areas'),
      ]);
      if (mine === generation.current) setLoaded({ rules, areas, areaId });
    } catch (failure) {
      if (mine === generation.current) setError(failure instanceof Error ? failure.message : 'Routing rules could not be read.');
    } finally { if (mine === generation.current) setLoading(false); }
  };
  useEffect(() => { setBusy(false); void reload(); return () => { generation.current++; }; }, [areaId]);
  const initial: RuleDraft = loaded?.areaId === areaId
    ? { fileRevision: loaded.rules.fileRevision, bindings: loaded.rules.bindings }
    : { fileRevision: '', bindings: [] };
  const draft = useDraftValue<RuleDraft>(draftKey('org-router-rule-bindings', areaId), initial);
  const dirty = draft.dirty;
  const stale = dirty && !!loaded && draft.value.fileRevision !== loaded.rules.fileRevision;
  const staleRef = useRevealWhen<HTMLParagraphElement>(stale);
  const confirm = async () => {
    if (!loaded || loaded.areaId !== areaId || busy || loading || !dirty || stale) return;
    const mine = generation.current;
    const sentKey = draft.key;
    const sentText = JSON.stringify(draft.value);
    setBusy(true); setError(''); setSaved(false);
    try {
      const reply = await apiPost<RulesReply>('/api/v1/router/rules', { bindings: draft.value.bindings, expectedRevision: draft.value.fileRevision });
      draft.clear(sentKey, sentText);
      if (mine !== generation.current) return;
      setLoaded({ ...loaded, rules: reply });
      setSaved(true);
    } catch (failure) {
      if (mine === generation.current) setError(failure instanceof Error ? failure.message : 'Area rules were not confirmed.');
    } finally { if (mine === generation.current) setBusy(false); }
  };
  return <section className="org-router-rules" data-testid="org-router-rules" aria-label="Incoming item rules">
    <h4>Incoming item rules</h4>
    <p className="org-router-hint">Pick an area for each rule. New mail that matches then goes there by itself; older mail, and mail two rules disagree on, waits for you. A message to a task outside the area still asks you first.</p>
    {!loaded && !error && <p role="status">Loading routing rules…</p>}
    {loaded?.areaId === areaId && <>
      {loaded.rules.rules.length === 0 && <p>No routing rules yet. Add sender or subject rules in Settings, then confirm their areas here.</p>}
      {loaded.rules.rules.map((rule) => {
        const binding = draft.value.bindings.find((one) => one.ruleId === rule.id);
        const current = binding?.areaId ?? '';
        const changed = !!binding && binding.revision !== rule.revision;
        return <fieldset key={rule.id} data-testid="router-rule" data-rule-id={rule.id} disabled={busy || loading}>
          <legend>{[rule.match.from && `Sender contains “${rule.match.from}”`, rule.match.subject && `Subject contains “${rule.match.subject}”`].filter(Boolean).join(' and ')}</legend>
          <p className="org-router-hint">Goes to: {rule.taskTitle || 'Existing task'}. {!rule.enabled ? 'Rule disabled.' : rule.confirmed ? 'Area confirmed.' : 'Area not confirmed.'}</p>
          {[{ id: '', name: 'Unassigned' }, ...loaded.areas.areas].map((area) => <label className="org-router-check" key={area.id}>
            <input type="radio" name={`router-rule-${areaId}-${rule.id}`} value={area.id} checked={current === area.id} data-draft-key={draft.key ?? undefined} onChange={() => {
              setSaved(false);
              draft.setValue((before) => ({ ...before, bindings: [...before.bindings.filter((one) => one.ruleId !== rule.id), ...(area.id ? [{ ruleId: rule.id, revision: rule.revision, areaId: area.id }] : [])] }));
            }} />{area.name}
          </label>)}
          {changed && <>
            <p className="org-router-warn">This rule changed. Its saved area is inactive until you confirm the new rule.</p>
            <button type="button" className="btn btn-sm" data-testid="router-rule-reconfirm" onClick={() => draft.setValue((before) => ({ ...before, bindings: before.bindings.map((one) => one.ruleId === rule.id ? { ...one, revision: rule.revision } : one) }))}>Use current rule</button>
          </>}
        </fieldset>;
      })}
      <div className="org-router-actions">
        <button type="button" className="btn btn-sm btn-primary" data-testid="router-rules-confirm" disabled={busy || loading || !dirty || stale} onClick={() => { void confirm(); }}>{busy ? 'Confirming…' : 'Confirm area rules'}</button>
        <button type="button" className="btn btn-sm" disabled={busy || loading || !dirty} onClick={() => { draft.clear(); setError(''); setSaved(false); }}>Discard changes</button>
        <span role="status">{saved ? 'Area rules confirmed.' : ''}</span>
      </div>
    </>}
    {stale && <p ref={staleRef} className="org-router-warn" role="alert" data-testid="router-rules-stale">Area rules changed elsewhere. Your draft is kept but cannot replace the newer confirmations. Discard it and choose again.</p>}
    {error && <p ref={errorRef} className="org-router-error" role="alert" data-testid="router-rules-error">{error}</p>}
    <button type="button" className="btn btn-sm" disabled={busy || loading} onClick={() => { void reload(); }}>Reload rules</button>
  </section>;
}
