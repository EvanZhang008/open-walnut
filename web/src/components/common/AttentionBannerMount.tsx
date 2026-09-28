/**
 * One switch per place the attention card can live (task panel, notification
 * panel, Ask Walnut slot, draft column). The owner rule (host-banner-placement)
 * picks the ONE mount that renders the card; every other mount unmounts it
 * entirely, so there is never a second card, a second dismiss list or a second
 * focus intent. The notification panel's mount sits in its System section and
 * renders only while that section shows, so it always renders the card. Live
 * inputs live in banner-mount-hooks.ts.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useHostBannerOwner, type BannerMount, type HostBannerOwner } from '@/utils/host-banner-placement';
import { AttentionBanner } from './AttentionBanner';
import {
  useBannerHealth, useClickGuard, useFinalWidthDuringOpen, useGrowPhase, useHoldLayout, useInstantAppear, useMeasuredHeight,
  useReserve, useSkipEnter,
} from './banner-mount-hooks';
import '@/styles/attention-banner-mount.css';

const TASKS_FOCUS = '.todo-section-tabs-list [role="tab"][aria-selected="true"]';
/** The card left the System section: focus goes to the rail entry the user is on. */
const NOTIFICATIONS_FOCUS = '.nfc-rail button[aria-current="true"]';

export interface AttentionBannerMountProps {
  where: BannerMount;
  health?: SystemHealth;
  healthLoading?: boolean;
  onNavigateSettings?: (hash?: string) => void;
  onStartSession?: () => void;
  onLeave?: () => void;
  singleLineRows?: boolean;
}

export function AttentionBannerMount(props: AttentionBannerMountProps): ReactNode {
  if (props.where === 'notifications') return <PanelMount {...props} owner="notifications" />;
  return <PageMount {...props} />;
}

function PageMount(props: AttentionBannerMountProps): ReactNode {
  const owner = useHostBannerOwner();
  if (props.where === 'tasks') return <PanelMount {...props} owner={owner} />;
  return owner === props.where ? <Card {...props} /> : null;
}

function Card({ where, health, healthLoading, onNavigateSettings, onStartSession, onLeave, singleLineRows, holdLayout, focusOnLeave }:
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
      singleLineRows={!!singleLineRows}
    />
  );
}

/**
 * Task panel and the notification panel's System section: an always-present
 * wrapper (the task panel's is a zero-height focus target when empty), a
 * 0fr-to-1fr grow on enter, the reserve box while the panel borrows the card,
 * the hold while the pointer is over what would move, and the click guard
 * after a height change (inside the section only: the rail never moves).
 */
function PanelMount(props: AttentionBannerMountProps & { owner: HostBannerOwner }): ReactNode {
  const { where, owner } = props;
  const { pathname } = useLocation();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const showCard = where === 'notifications' || owner === where;
  const h = useMeasuredHeight(content);
  const reserve = useReserve(where, owner, pathname, h);
  const { skip: skipEnter, minHeight } = useSkipEnter(where, reserve, h, el);
  // Only changed place (back to Home, a panel closed) or the page is loading: no grow.
  const instant = useInstantAppear(showCard, h > 0);
  const phase = useGrowPhase(h > 0 || skipEnter, skipEnter || instant);
  const finalWidth = useFinalWidthDuringOpen(where === 'tasks' ? el : null, showCard);
  const hold = useHoldLayout(where, el);
  useClickGuard(el, where === 'tasks' ? '.todo-panel' : '.nfc-detail');
  const focusOnLeave = useCallback((): void => {
    const target = where === 'tasks'
      ? document.querySelector<HTMLElement>(TASKS_FOCUS) ?? el
      : el?.closest('.notification-panel')?.querySelector<HTMLElement>(NOTIFICATIONS_FOCUS)
        ?? el?.closest('.notification-panel')?.querySelector<HTMLElement>('.nfc-rail button');
    target?.focus({ preventScroll: true });
  }, [where, el]);
  // Not empty while the card takes its reserve's place back (its height is not measured yet).
  const empty = reserve === null && !skipEnter && (!showCard || h === 0);
  return (
    <div
      ref={setEl}
      className="ab-mount"
      data-mount={where}
      data-empty={empty ? 'true' : 'false'}
      {...(where === 'tasks' ? { tabIndex: -1, role: 'group', 'aria-label': 'Task panel' } : {})}
      onPointerDown={(e) => e.stopPropagation()}
      {...(minHeight !== null ? { style: { minHeight } } : {})}
    >
      {reserve !== null && !showCard ? (
        <div className="ab-mount-reserve" aria-hidden="true" style={{ height: reserve }} />
      ) : (
        <div className="ab-mount-anim" data-phase={phase}>
          <div className="ab-mount-anim-inner">
            <div ref={setContent} className="ab-mount-content" {...(finalWidth !== null ? { style: { width: finalWidth } } : {})}>
              {showCard && <Card {...props} holdLayout={hold} focusOnLeave={focusOnLeave} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
