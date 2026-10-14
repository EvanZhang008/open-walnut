import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '@/api/client';
import type { SessionUsage } from '@/api/session-usage';
import type { SessionUsageView } from '@/hooks/useSessionBudgetUsage';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import {
  breakdownCost, budgetPauseLabel, draftFromUsage, formatUsageCost, parseBudgetLimit,
  reconcileBudgetDraft, remainingAllowance, verifiedLifetimeCost, type BudgetDraft,
} from './session-usage-model';
import '@/styles/session-usage.css';

interface SessionUsageDialogProps {
  sessionId: string;
  title?: string | null;
  usage: SessionUsageView;
  onClose: () => void;
}

export function SessionBudgetStatus({ data, onOpen }: { data: SessionUsage | null; onOpen: () => void }) {
  const label = budgetPauseLabel(data);
  if (!label) return null;
  return (
    <div className="session-budget-status" role="status">
      <span>{label}{data?.budget.stopError ? '. Stop not confirmed.' : ''}</span>
      <button type="button" onClick={onOpen}>Usage &amp; Budget</button>
    </div>
  );
}

export function SessionUsageDialog({ sessionId, title, usage, onClose }: SessionUsageDialogProps) {
  const data = usage.data?.sessionId === sessionId ? usage.data : null;
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<BudgetDraft | null>(() => data ? draftFromUsage(data) : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [conflictPending, setConflictPending] = useState(false);
  const mounted = useRef(true);
  const identity = useRef(sessionId);
  identity.current = sessionId;
  const saving = useRef(false);
  const labelId = useId();
  const helpId = useId();
  const errorId = useId();
  useModalOverlay(onClose);
  useDialogFocus(panel, 'Usage & Budget');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (data) setDraft(current => reconcileBudgetDraft(current, data));
  }, [data]);

  const refreshConflict = useCallback(async () => {
    const sid = sessionId;
    const latest = await usage.refresh();
    if (!mounted.current || identity.current !== sid || !latest || latest.sessionId !== sid) return;
    setDraft(current => reconcileBudgetDraft(current, latest, true));
    setConflictPending(false);
    setSaveError('The budget changed elsewhere. Latest values are shown; your edit is kept. Review it and save again.');
  }, [sessionId, usage.refresh]);

  const save = async (remove = false) => {
    if (!draft || saving.current || usage.saving || conflictPending) return;
    const parsed = remove ? { valid: true as const, limitUsd: null } : parseBudgetLimit(draft.text);
    if (!parsed.valid) { setSaveError(parsed.error); return; }
    const sid = sessionId;
    if (remove) setDraft({ ...draft, text: '', dirty: true });
    saving.current = true;
    setSaveError(null);
    setSaved(false);
    try {
      const latest = await usage.save(parsed.limitUsd, draft.revision);
      if (!mounted.current || identity.current !== sid) return;
      setDraft(draftFromUsage(latest));
      setSaved(true);
    } catch (error: unknown) {
      if (!mounted.current || identity.current !== sid) return;
      if (error instanceof ApiError && error.status === 409) {
        setConflictPending(true);
        setSaveError('The budget changed elsewhere. Refreshing before another save; your edit is kept.');
        await refreshConflict();
      } else {
        setSaveError(`Could not save the budget. ${error instanceof Error ? error.message : String(error)} Retry when ready.`);
      }
    } finally {
      saving.current = false;
    }
  };

  const total = data ? verifiedLifetimeCost(data) : null;
  const remaining = data ? remainingAllowance(data) : null;
  const parsed = draft ? parseBudgetLimit(draft.text) : null;
  const pauseLabel = budgetPauseLabel(data);
  return createPortal(
    <div className="app-modal-overlay session-usage-overlay" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
      <div ref={setPanel} className="app-modal session-usage-dialog" role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1} onPointerDown={event => event.stopPropagation()}>
        <header className="session-usage-heading">
          <div>
            <h2 id={labelId} className="app-modal-title">Usage &amp; Budget</h2>
            <p className="session-usage-title">{title || data?.title || 'This session'}</p>
          </div>
          <button type="button" className="session-usage-close" aria-label="Close Usage & Budget" onClick={onClose}>×</button>
        </header>
        {!data && <p role="status">{usage.loading ? 'Checking session usage…' : 'Session usage is unavailable.'}</p>}
        {usage.error && (
          <div className="session-usage-error" role="alert">
            <span>{data ? 'Usage could not be refreshed. Showing the last check. ' : ''}{usage.error}</span>
            <button type="button" className="app-modal-btn" disabled={usage.loading} onClick={() => void usage.refresh()}>{usage.loading ? 'Refreshing…' : 'Retry refresh'}</button>
          </div>
        )}
        {data && (
          <>
            <section className="session-usage-total" aria-label="Lifetime usage">
              <span className="session-usage-label">Lifetime cost</span>
              <strong>{formatUsageCost(total)}</strong>
              <span className="session-usage-hint">{data.verifiedCalls} verified {data.verifiedCalls === 1 ? 'call' : 'calls'}{data.unverifiedCalls > 0 ? ` · ${data.unverifiedCalls} unverified` : ''}</span>
              {total === null && data.verifiedCostUsd !== null && Number.isFinite(data.verifiedCostUsd) && data.verifiedCostUsd >= 0 && (
                <span className="session-usage-hint">Known verified portion: {formatUsageCost(data.verifiedCostUsd)}. Not the lifetime total.</span>
              )}
            </section>
            <form className="session-usage-budget" onSubmit={event => { event.preventDefault(); void save(); }}>
              <label htmlFor={`${labelId}-limit`}>Total lifetime limit (USD)</label>
              <div className="session-usage-edit-row">
                <input id={`${labelId}-limit`} className="app-modal-input" type="text" inputMode="decimal" autoComplete="off" placeholder="No limit" value={draft?.text ?? ''} disabled={!draft || usage.saving} aria-describedby={`${helpId}${saveError ? ` ${errorId}` : ''}`} aria-invalid={draft?.dirty && parsed?.valid === false ? true : undefined}
                  onChange={event => { const text = event.target.value; setDraft(current => current ? { ...current, text, dirty: true } : current); setSaved(false); if (!conflictPending) setSaveError(null); }} />
                <button type="submit" className="app-modal-btn primary" disabled={!draft?.dirty || usage.saving || conflictPending}>{usage.saving ? 'Saving…' : 'Save limit'}</button>
              </div>
              <p id={helpId} className="session-usage-hint">Includes prior spending and subagents. Never resets. Leave blank for no limit.</p>
              {draft?.dirty && parsed?.valid === false && <p className="session-usage-error-text">{parsed.error}</p>}
              <div className="session-usage-budget-facts">
                <span>Saved limit: {data.budget.limitUsd === null ? 'No limit' : formatUsageCost(data.budget.limitUsd)}</span>
                {remaining !== null && <span>Remaining: {formatUsageCost(remaining)}</span>}
                {data.budget.limitUsd !== null && <button type="button" className="session-usage-text-button" disabled={usage.saving || conflictPending} onClick={() => void save(true)}>Remove limit</button>}
              </div>
              {pauseLabel && <p className="session-usage-paused" role="status">{pauseLabel}</p>}
              {data.budget.stopError && <p className="session-usage-error-text" role="alert">Stop could not be confirmed. The session may still be running. {data.budget.stopError}</p>}
              {saveError && <div id={errorId} className="session-usage-error" role="alert"><span>{saveError}</span>{conflictPending && <button type="button" className="app-modal-btn" disabled={usage.loading} onClick={() => void refreshConflict()}>{usage.loading ? 'Refreshing…' : 'Refresh budget'}</button>}</div>}
              {saved && <p className="session-usage-hint" role="status">Budget saved. No message was sent. Send your next message when ready.</p>}
            </form>
            <section className="session-usage-breakdown" aria-label="Usage by agent">
              <h3>By agent</h3>
              {data.byAgent.length === 0 && <p className="session-usage-hint">No recorded calls yet.</p>}
              {data.byAgent.map(row => <UsageRow key={row.agent} label={row.agent === 'main' ? 'Main agent' : 'Subagents'} cost={formatUsageCost(breakdownCost(row))} calls={row.calls} unverified={row.unverifiedCalls} />)}
            </section>
            <section className="session-usage-breakdown" aria-label="Usage by model">
              <h3>By model</h3>
              {data.byModel.length === 0 && <p className="session-usage-hint">No recorded calls yet.</p>}
              {data.byModel.map(row => <UsageRow key={row.model} label={row.model || 'Unknown model'} cost={formatUsageCost(breakdownCost(row))} calls={row.calls} unverified={row.unverifiedCalls} />)}
            </section>
            <p className="session-usage-hint session-usage-disclaimer">Estimated from token usage, not an invoice. In-flight requests may exceed the allowance. Raising or removing a limit does not send a message.</p>
            {data.checkedAt && <p className="session-usage-hint">Last checked: {new Date(data.checkedAt).toLocaleString()}</p>}
          </>
        )}
        <footer className="app-modal-actions"><button type="button" className="app-modal-btn" onClick={onClose}>Close</button></footer>
      </div>
    </div>, document.body,
  );
}

function UsageRow({ label, cost, calls, unverified }: { label: string; cost: string; calls: number; unverified: number }) {
  return <div className="session-usage-row"><div><span className="session-usage-row-name">{label}</span><span className="session-usage-hint">{calls} {calls === 1 ? 'call' : 'calls'}{unverified > 0 ? ` · ${unverified} unverified` : ''}</span></div><span className="session-usage-row-cost">{cost}</span></div>;
}
