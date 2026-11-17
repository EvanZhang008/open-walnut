/**
 * The one line under the bell's Errors view that says where Walnut's own errors went:
 * Settings > Walnut Health (src/core/notifications/audience.ts decides which is which).
 * Shows only while Health holds an open one, so the bell stays about the person.
 */
import { useNotifications } from '@/contexts/notifications';
import '@/styles/health-monitor.css';

export const WALNUT_HEALTH_ERRORS_PATH = '/settings#walnut-health-errors';

export function HealthErrorsLink({ onNavigate }: { onNavigate: (to: string) => void }) {
  const { healthFeed } = useNotifications();
  const open = healthFeed.filter(n => !n.resolved).length;
  if (open === 0) return null;
  return (
    <button
      type="button"
      className="nfc-health-link"
      data-testid="nfc-health-link"
      onClick={() => onNavigate(WALNUT_HEALTH_ERRORS_PATH)}
    >
      {open === 1 ? '1 background error' : `${open} background errors`} Walnut is handling: see Walnut Health
    </button>
  );
}
