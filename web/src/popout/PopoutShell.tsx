/**
 * The app of a pop-out window (`/popout?view=…`): what App.tsx draws for one, without loading the
 * console (Home, the apps, the pages) a pop-out never shows. main.tsx mounts this instead of App
 * for a pop-out address, so a pop-out window evaluates only its own view's code (popout-views.ts);
 * the browser extension's side panel opens one on every open (2026-11-06: the whole console took
 * about 700 ms to evaluate there before anything drew).
 *
 * The hooks are App's that act in a pop-out (the live connection, task and agent link clicks,
 * open-letter requests, open links). A pop-out that navigates to an app path (a link that leaves
 * it) gets the whole App, loaded then.
 */
import { lazy, Suspense, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useTaskLinkClickFallback } from '@/hooks/useTaskLinkClickFallback';
import { useHidesHighlights } from '@/hooks/useHidesHighlights';
import { useAgentLinkClickFallback, useOpenLetterRequests } from '@/utils/open-anywhere';
import { navigateToTarget } from '@/utils/open-session';
import { rememberLocation } from '@/utils/last-location';
import { pageKeyForPath, recordVisit } from '@/api/page-visits';
import { PLUGIN_STORE_PATH, peekPendingInstall, subscribeOpenLinks, subscribeOpenTargets, takePendingTarget } from '@/utils/open-link';
import { StaleBuildPill } from '@/components/common/StaleBuildPill';
import { AnywhereFileViewer } from '@/components/common/AnywhereFileViewer';
import { SessionRawViewHost } from '@/components/sessions/SessionRawView';
import { LinkCaptureHost } from '@/plugins/LinkCaptureHost';
import { PluginDialogHost } from '@/plugins/PluginDialogHost';
import { PasswordsUnlockHost } from '@/plugins/PasswordsUnlockHost';
import { isPopoutPath } from './openPopout';
import { PopoutRoot } from './PopoutRoot';

const WholeApp = lazy(() => import('../App').then((m) => ({ default: m.App })));

export function PopoutShell() {
  const location = useLocation();
  if (!isPopoutPath(location.pathname)) return <Suspense fallback={null}><WholeApp /></Suspense>;
  return <PopoutApp />;
}

function PopoutApp() {
  useWebSocket();
  const location = useLocation();
  const navigate = useNavigate();
  useTaskLinkClickFallback(navigate);
  useAgentLinkClickFallback();
  useOpenLetterRequests(true);
  // An install link opens the Plugin Store (leaving the pop-out); an open link goes there.
  useEffect(() => {
    const go = () => { if (peekPendingInstall()) navigate(PLUGIN_STORE_PATH); };
    go();
    return subscribeOpenLinks(go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const go = (to: string) => navigateToTarget(to, navigate);
    const waiting = takePendingTarget();
    if (waiting) go(waiting);
    return subscribeOpenTargets(go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { rememberLocation(location); }, [location]);
  useEffect(() => { recordVisit(pageKeyForPath(location.pathname)); }, [location.pathname]);
  // Home is not mounted here, so no chat's marks are on another page; App passes the same.
  useHidesHighlights(true);
  // The hosts App mounts for a pop-out, all of them: a plugin's dialog opened here (a
  // walnut.ui.openDialog from its events) had nowhere to draw (tests/web/popout-light-entry-guard.test.ts).
  return <><StaleBuildPill /><LinkCaptureHost /><PluginDialogHost /><PasswordsUnlockHost /><SessionRawViewHost /><AnywhereFileViewer /><PopoutRoot /></>;
}
