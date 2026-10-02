/**
 * The heavy pill on a session column's tool row: shown only while the session's
 * process tree is over the heavy line (1.5 GB of RSS or a full core of CPU,
 * src/core/sessions/session-resources.ts), so a quiet session wears nothing.
 * Hover lists the processes behind the number. The Machine readout in the
 * notification panel's System tab has the whole picture and the Stop button.
 */
import { memo } from 'react';
import { useSessionResources } from '@/stores/session-resources-store';
import { formatCpu, formatMemory, formatProcCount, heavyPillText } from '@/utils/resource-format';
import '@/styles/session-resources.css';

export const SessionResourcePill = memo(function SessionResourcePill({ sessionId }: { sessionId: string }) {
  const row = useSessionResources(sessionId);
  if (!row || !row.heavy) return null;
  const lines = row.top.slice(0, 5).map((p) => `${p.comm} (${p.pid}): ${formatMemory(p.rssBytes)}${p.cpuPct != null ? `, ${formatCpu(p.cpuPct)} CPU` : ''}`);
  const title = [`This session uses ${formatMemory(row.rssBytes)} across ${formatProcCount(row.procCount)}`
    + (row.cpuPct != null ? ` and ${formatCpu(row.cpuPct)} CPU` : '') + '.', ...lines, 'Machine readout: notification panel, System.'].join('\n');
  return (
    <span className="session-action-chip session-resource-pill" data-testid="session-resource-pill" title={title} aria-label={title}>
      <span className="session-resource-pill-dot" aria-hidden="true" />
      {heavyPillText(row)}
    </span>
  );
});
