import { useState, useRef, useEffect, useCallback } from 'react';
import { updateSession } from '@/api/sessions';
import type { ProcessStatus, WorkStatus } from '@/types/session';
import { WORK_LABELS, WORK_COLORS, PROCESS_COLORS } from '@/utils/session-status';

/** Work statuses the user can manually set (backend-allowed). */
const SETTABLE_STATUSES: WorkStatus[] = ['agent_complete', 'await_human_action', 'completed'];

interface WorkStatusPickerProps {
  sessionId: string;
  processStatus: ProcessStatus;
  workStatus: WorkStatus;
  /** Badge size variant. */
  size?: 'sm' | 'md';
  /** Called after a successful status change so parent can update local state. */
  onChanged?: (newStatus: WorkStatus) => void;
}

export function WorkStatusPicker({ sessionId, processStatus, workStatus, size = 'md', onChanged }: WorkStatusPickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const ps = processStatus;
  const ws = workStatus;
  const wsColor = WORK_COLORS[ws];
  const wsLabel = WORK_LABELS[ws];
  const psColor = PROCESS_COLORS[ps];

  // Can only change work_status when process is stopped
  const canChange = ps === 'stopped' && !saving;

  // Options: all settable statuses except current
  const options = SETTABLE_STATUSES.filter(s => s !== ws);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = useCallback(async (newStatus: WorkStatus) => {
    setOpen(false);
    setSaving(true);
    try {
      await updateSession(sessionId, { work_status: newStatus });
      onChanged?.(newStatus);
    } catch (err) {
      console.error('Failed to update work_status:', err);
    } finally {
      setSaving(false);
    }
  }, [sessionId, onChanged]);

  const badgeBase = size === 'sm' ? 'session-panel-badge' : 'session-detail-badge';

  return (
    <div ref={containerRef} className="work-status-picker" style={{ position: 'relative', display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
      {/* Process status badge — always read-only */}
      <span
        className={badgeBase}
        style={{
          color: psColor,
          background: size === 'sm'
            ? `color-mix(in srgb, ${psColor} 8%, transparent)`
            : `${psColor}14`,
        }}
      >
        {ps === 'running' && (
          <span
            className={size === 'sm' ? 'session-panel-badge-dot' : 'session-detail-badge-dot'}
            style={{ background: psColor }}
          />
        )}
        {ps === 'running' ? 'Running' : 'Stopped'}
      </span>

      {/* Work status badge — clickable dropdown when process is stopped */}
      <span
        className={badgeBase}
        style={{
          color: wsColor,
          background: size === 'sm'
            ? `color-mix(in srgb, ${wsColor} 8%, transparent)`
            : `${wsColor}14`,
          cursor: canChange ? 'pointer' : 'default',
        }}
        onClick={canChange ? () => setOpen(!open) : undefined}
        title={canChange ? 'Click to change work status' : wsLabel}
        role={canChange ? 'button' : undefined}
        tabIndex={canChange ? 0 : undefined}
        onKeyDown={canChange ? (e) => { if (e.key === 'Enter' || e.key === ' ') setOpen(!open); } : undefined}
      >
        {saving ? 'Saving\u2026' : wsLabel}
        {canChange && <span style={{ fontSize: '8px', marginLeft: '2px', opacity: 0.6 }}>{open ? '\u25B4' : '\u25BE'}</span>}
      </span>

      {open && (
        <div className="work-status-picker-dropdown">
          {options.map(status => (
            <button
              key={status}
              className="work-status-picker-option"
              onClick={() => handleSelect(status)}
            >
              <span className="work-status-picker-dot" style={{ background: WORK_COLORS[status] }} />
              {WORK_LABELS[status]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
