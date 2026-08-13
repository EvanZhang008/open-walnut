import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlanCard } from './SessionMessage';
import { visibleInterval } from '@/utils/page-visibility';
import type { SessionRecord } from '@/types/session';
import type { SessionPlanResponse } from '@/api/sessions';

const PLAN_POLL_INTERVAL = 15_000; // 15s

interface PlanPreviewSectionProps {
  session: SessionRecord;
  plan: SessionPlanResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function PlanPreviewSection({ session, plan, loading, refresh }: PlanPreviewSectionProps) {
  const navigate = useNavigate();
  const hasPlan = !!session.planCompleted;
  const isFromPlan = !!session.fromPlanSessionId;
  const shouldFetch = hasPlan || isFromPlan;
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Reset open state when session changes
  useEffect(() => {
    setOpen(false);
  }, [session.claudeSessionId]);

  // Auto-poll for plan updates while session is running.
  // visibleInterval: sessions run for hours — a hidden tab must not poll along.
  useEffect(() => {
    if (!shouldFetch) return;
    const isRunning = session.process_status === 'running';
    if (!isRunning) return;

    return visibleInterval(() => {
      refresh();
    }, PLAN_POLL_INTERVAL);
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
          className="task-action-btn plan-preview-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh plan content"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={refreshing ? 'plan-preview-refresh-spin' : ''}>
            <path d="M1.5 8a6.5 6.5 0 0111.3-4.4"/><polyline points="13 1 13 4.5 9.5 4.5"/>
            <path d="M14.5 8a6.5 6.5 0 01-11.3 4.4"/><polyline points="3 15 3 11.5 6.5 11.5"/>
          </svg>
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
