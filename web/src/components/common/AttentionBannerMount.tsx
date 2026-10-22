/**
 * One switch per place the attention card can live on the page (task panel,
 * Ask Walnut slot, draft column). The owner rule (host-banner-placement) picks
 * the ONE mount that renders the card; every other mount unmounts it entirely,
 * so there is never a second card, a second dismiss list or a second focus
 * intent. The notification panel holds no card: its System section lists every
 * host once (NotificationHostRow). Live inputs live in banner-mount-hooks.ts.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useHostBannerOwner, type BannerMount, type HostBannerOwner } from '@/utils/host-banner-placement';
import { AttentionBanner } from './AttentionBanner';
import {
  useBannerHealth, useClickGuard, useHoldLayout,
} from './banner-mount-hooks';
import '@/styles/attention-banner-mount.css';

const TASKS_FOCUS = '.todo-section-tabs-list [role="tab"][aria-selected="true"]';

export interface AttentionBannerMountProps {
  where: BannerMount;
  health?: SystemHealth;
  healthLoading?: boolean;
  onNavigateSettings?: (hash?: string) => void;
  onStartSession?: () => void;
  onLeave?: () => void;
}

export function AttentionBannerMount(props: AttentionBannerMountProps): ReactNode {
  const owner = useHostBannerOwner();
  if (props.where === 'tasks') return <TasksMount {...props} owner={owner} />;
  return owner === props.where ? <Card {...props} /> : null;
}

function Card({ where, health, healthLoading, onNavigateSettings, onStartSession, onLeave, holdLayout, focusOnLeave }:
  AttentionBannerMountProps & { holdLayout?: boolean; focusOnLeave?: () => void }): ReactNode {
  const navigate = useNavigate();
  const shared = useBannerHealth();
  const nav = useCallback((hash?: string) => {
    if (onNavigateSettings) onNavigateSettings(hash); else navigate(`/settings${hash ?? ''}`);
  }, [onNavigateSettings, navigate]);
  return (
    <AttentionBanner
      mount={where}
      health={health ?? shared.health}
      healthLoading={health ? healthLoading : shared.loading}
      onNavigateSettings={nav}
      {...(onStartSession ? { onStartSession } : {})}
      {...(onLeave ? { onLeave } : {})}
      {...(focusOnLeave ? { focusOnLeave } : {})}
      holdLayout={!!holdLayout}
    />
  );
}

/** The bottom task-panel disclosure retains the card while its body is hidden. */
function TasksMount(props: AttentionBannerMountProps & { owner: HostBannerOwner }): ReactNode {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const hold = useHoldLayout('tasks', el);
  useClickGuard(el, '.todo-panel');
  const focusOnLeave = useCallback((): void => {
    (document.querySelector<HTMLElement>(TASKS_FOCUS) ?? el)?.focus({ preventScroll: true });
  }, [el]);
  return (
    <div ref={setEl} className="ab-mount" data-mount="tasks" tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()}>
      {props.owner === 'tasks' && <Card {...props} holdLayout={hold} focusOnLeave={focusOnLeave} />}
    </div>
  );
}
