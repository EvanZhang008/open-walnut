/**
 * Settings > Walnut Health > Background errors > Remote hosts: the host problems that are
 * Walnut's to clear (audience.ts hostProblemNeedsYou): a machine that is off or asleep, a
 * network, a daemon that did not start. Walnut reconnects them by itself and its health
 * monitor investigates the ones that stay; they never toast or light the bell. Each row keeps
 * the full hint (a command to check it by hand included) for whoever investigates
 * (2026-11-17, the user: a machine that is not connected must not ask him to run a command).
 */
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { openHostSettings } from '@/utils/host-settings-nav';
import { useDisabledHosts, useProblemHosts, type ProblemHost } from '@/components/common/NotificationProblems';
import { SettingsButton } from '../inputs/SettingsButton';
import { NoticeStatus } from '@/components/common/NoticeCard';

/** The hosts Walnut Health holds now (the bell holds the others). */
export function useHealthProblemHosts(): ProblemHost[] {
  const { health } = useSystemHealth();
  const disabled = useDisabledHosts(true);
  return useProblemHosts(health.daemons, disabled).filter((p) => !p.needsYou);
}

export function HealthHostProblems({ hosts }: { hosts: ProblemHost[] }) {
  const navigate = useNavigate();
  if (hosts.length === 0) return null;
  return (
    <div className="health-errors-group" data-testid="health-errors-group" data-category="Remote hosts">
      <div className="health-errors-group-head" role="heading" aria-level={4}>
        <span className="health-errors-cat">Remote hosts</span>
        <span className="health-errors-meta">
          <span className="health-count-ALARM">{hosts.length} happening · </span>
          Walnut keeps reconnecting {hosts.length === 1 ? 'it' : 'them'}
        </span>
      </div>
      <ul className="health-errors-rows">
        {hosts.map(({ alias, row }) => (
          <li key={alias} className="health-errors-row health-errors-open" data-testid="health-host-row" data-host={alias}>
            <div className="health-errors-row-head">
              <NoticeStatus className="health-pill" tone="error">Happening</NoticeStatus>
              <span className="health-errors-title">{row.headline ?? row.problem?.message ?? `${row.labels.join(', ')} cannot be reached`}</span>
            </div>
            <div className="health-errors-detail">
              {/* The one rendering of a host failure: the hint, and the captured output behind its toggle. */}
              <HostFailureText headline="" {...(row.hint ? { hint: row.hint } : {})} {...(row.summary ? { summary: row.summary } : {})} {...(row.kind ? { kind: row.kind } : {})} />
              <div className="health-detail-actions">
                <SettingsButton onClick={() => openHostSettings(navigate, alias)}>Open host settings</SettingsButton>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
