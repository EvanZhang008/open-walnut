/**
 * Settings > Phones & Cloud itself: it has no page of its own, it opens the tab the
 * phone uses (cloud/PhonesCloudTabs.tsx) once the device list says which, and shows
 * the tab bar over a loading line until then.
 *
 * The bar is live while it waits (Tailscale's first probe can take seconds), so the
 * person may pick a tab first, and the tab they pick wins (2026-11-05, WebKit: a tab
 * pressed just as the answer came in did nothing). Two rules keep it so: the move
 * waits while a press on the bar is down, because moving swaps the tab under the
 * pointer for another one and the browser then clicks neither; and the move happens
 * only while the page is still where it opened, so a tab opened meanwhile is kept.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsGroup, SettingsLoadingRow } from '../SettingsSection';
import { PHONES_CLOUD_PANE } from '../settings-way-panes';
import { PRESS_MAX_MS } from '../inputs/press-keeps-target';
import { PANE_TITLE, TabBar, usePhonesCloudView } from './cloud/PhonesCloudTabs';
import { landingMayReplace } from './cloud/ways-model';

/** Whether a press on the bar is down. It ends after the release's own click has run. */
function usePressDown(): [boolean, (e: ReactPointerEvent) => void] {
  const [down, setDown] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const onPointerDownCapture = useCallback((e: ReactPointerEvent) => {
    if (!e.isPrimary || stop.current) return;
    setDown(true);
    const release = () => {
      stop.current?.();
      // A timer, not now: the release's click is dispatched right after pointerup, in the same task.
      window.setTimeout(() => setDown(false), 0);
    };
    const timer = window.setTimeout(release, PRESS_MAX_MS);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    // A tab is a link: dragged, it starts the browser's own drag, and WebKit then sends no pointerup.
    window.addEventListener('dragstart', release, true);
    window.addEventListener('blur', release);
    stop.current = () => {
      stop.current = null;
      window.clearTimeout(timer);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('dragstart', release, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  return [down, onPointerDownCapture];
}

/** Phones & Cloud itself: opens the tab in use once the list says which. */
export function PhonesCloudLanding() {
  const navigate = useNavigate();
  const view = usePhonesCloudView();
  const [pressDown, onPointerDownCapture] = usePressDown();
  useEffect(() => {
    // A tab the person picked while the list loaded stays open (landingMayReplace), and a press on
    // the bar ends before the landing moves the tabs under it.
    if (!view.landing || pressDown) return;
    if (landingMayReplace(window.location.hash, PHONES_CLOUD_PANE)) navigate({ hash: `#${view.landing}` }, { replace: true });
  }, [view.landing, pressDown, navigate]);
  return (
    <SettingsSection id={PHONES_CLOUD_PANE} title={PANE_TITLE}>
      <div
        className="pc-head"
        onPointerDownCapture={onPointerDownCapture}
        data-landing-waits={view.landing && pressDown ? 'press' : undefined}
      >
        <TabBar tabs={view.tabs} current={null} />
      </div>
      <SettingsGroup>
        <SettingsLoadingRow>{view.now.title}</SettingsLoadingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
