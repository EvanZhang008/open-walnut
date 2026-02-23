import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlanCard } from './SessionMessage';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import type { SessionRecord } from '@/types/session';

const PLAN_POLL_INTERVAL = 15_000; // 15s

export function PlanPreviewSection({ session }: { session: SessionRecord }) {
  const navigate = useNavigate();
  const hasPlan = !!session.planCompleted;
  const isFromPlan = !!session.fromPlanSessionId;
  const shouldFetch = hasPlan || isFromPlan;
  const { plan, loading, refresh } = useSessionPlan(session.claudeSessionId, shouldFetch);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Reset open state when session changes
  useEffect(() => {
    setOpen(false);
  }, [session.claudeSessionId]);

  // Auto-poll for plan updates while session is running
  useEffect(() => {
    if (!shouldFetch) return;
    // Only poll when session is still running (plan may still be updating)
    const isRunning = session.process_status === 'running';
    if (!isRunning) return;

    const interval = setInterval(() => {
      refresh();
    }, PLAN_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [shouldFetch, session.process_status, refresh]);

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  if (!shouldFetch) return null;
  if (loading && !plan) {
    return (
      <div className="plan-preview-section">
        <div className="plan-preview-loading">Loading plan...</div>
      </div>
    );
  }
  if (!plan) return null;

  const filename = plan.planFile?.split('/').pop() ?? 'plan.md';
  const sectionTitle = isFromPlan ? 'Source Plan' : 'Plan';

  return (
    <div className="plan-preview-section">
      <button className="plan-preview-toggle" onClick={() => setOpen(p => !p)}>
        <span className="plan-preview-arrow">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="plan-preview-title">{sectionTitle}</span>
        <code className="plan-preview-filename" title={plan.planFile || filename}>{filename}</code>
        <button
          className="plan-preview-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh plan content"
        >
          <span className={refreshing ? 'plan-preview-refresh-spin' : ''}>&#x1F504;</span>
        </button>
      </button>
      {isFromPlan && plan.sourceSessionId && (
        <div className="plan-preview-source">
          from session{' '}
          <a
            href={`/sessions?id=${plan.sourceSessionId}`}
            className="plan-preview-source-link"
            onClick={(e) => {
              e.preventDefault();
              navigate(`/sessions?id=${plan.sourceSessionId}`);
            }}
          >
            {plan.sourceSessionId.slice(0, 12)}...
          </a>
        </div>
      )}
      {open && (
        <div className="plan-preview-body">
          <PlanCard content={plan.content} />
        </div>
      )}
    </div>
  );
}
