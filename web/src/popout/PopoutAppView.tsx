/**
 * An app in a window of its own (`/popout?view=app&app=<key>`, opened by the sidebar's
 * "Open in new window", openPopout.ts `openAppWindow`): the app alone, no Home or sidebar,
 * drawn the way the console draws it (AppHostPage for plugin Apps, CoreAppView for the
 * built-in ones).
 *
 * Moving inside the app stays in this window and in its memory: the app gets a router of its
 * own, so the window's address keeps naming the app and never changes. That is what lets the
 * Mac app bring this window forward when the app is opened again (it finds a window by its
 * exact address, desktop/LinkPolicy.swift). Where the person was in the app is kept in this
 * window's session storage, so a reload comes back there. A move that leaves the app goes to
 * the window's own router, which draws the whole console there (as a link that leaves any
 * pop-out does, PopoutShell.tsx).
 *
 * The app's open/closed record (apps_stay_open, apps/store.ts) belongs to the console's
 * sidebar: this window neither opens nor closes the app there.
 */
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { AppHostPage, CoreAppView } from '@/apps/AppHostPage';
import { ensureCoreAppsRegisteredLazily, preloadCoreScreen } from '@/apps/core-apps-lazy';
import { useAppCatalog } from '@/apps/hooks';
import type { RegisteredApp } from '@/apps/registry';
import { useWebPluginRuntime } from '@/plugins/runtime-store';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { NotificationToaster } from '@/components/common/NotificationToaster';
import { OperationErrorBridge } from '@/components/common/OperationErrorBridge';
import { TransferDialogHost } from '@/components/transfer/TransferDialogHost';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider } from '@/contexts/FocusBarContext';
import { TaskUndoProvider } from '@/undo/TaskUndoContext';
import { linkTargetFor } from '@/utils/last-location';
import { appWindowPlaceKey, appWindowStart, isPlaceInApp } from './app-window-place';
import { AppOwnRouter } from './AppOwnRouter';
import './popout-app.css';

// The console registers these in App.tsx, which a pop-out window never loads. Only this window's
// own screen is loaded, started now, alongside the shell (core-apps-lazy.tsx).
ensureCoreAppsRegisteredLazily();
preloadCoreScreen(new URLSearchParams(window.location.search).get('app') ?? '');

export function PopoutAppView() {
  const [params] = useSearchParams();
  const appKey = params.get('app') ?? '';
  return (
    <TasksProvider>
      <NotificationProvider>
        <FocusBarProvider>
          <TaskUndoProvider>
            <AppWindow appKey={appKey} />
            <NotificationToaster />
            <OperationErrorBridge />
            <TransferDialogHost />
          </TaskUndoProvider>
        </FocusBarProvider>
      </NotificationProvider>
    </TasksProvider>
  );
}

function AppWindow({ appKey }: { appKey: string }) {
  const catalog = useAppCatalog();
  const runtime = useWebPluginRuntime();
  const leave = useNavigate();
  const app = catalog.all.find((item) => item.key === appKey);
  const title = app?.title;
  useEffect(() => { if (title) document.title = `${title} · Walnut`; }, [title]);

  if (!app) {
    // Plugin Apps (and Mail, which waits on its plugin) arrive once the plugins have loaded.
    if (!runtime.ready || runtime.loading || catalog.loadingWebviews) return <LoadingSpinner />;
    return (
      <div className="popout-stub" data-testid="popout-app-missing">
        <h2>This app is not available</h2>
        <p>It may be turned off or uninstalled. The Apps page in Walnut lists what is installed.</p>
      </div>
    );
  }
  return (
    <div
      className="popout-app app-content-area"
      data-testid="popout-app"
      data-app-key={app.key}
      style={app.fullBleed ? { padding: 0, overflow: 'hidden' } : undefined}
    >
      <Suspense fallback={null}>
        <AppRouter key={app.key} app={app} leave={leave} />
      </Suspense>
    </div>
  );
}

function AppRouter({ app, leave }: { app: RegisteredApp; leave: NavigateFunction }) {
  const start = useMemo(() => {
    let kept: string | null = null;
    try { kept = sessionStorage.getItem(appWindowPlaceKey(app.key)); } catch { /* private browsing */ }
    return appWindowStart(app, kept, linkTargetFor(app.path));
    // The start is read once per app; later moves are the router's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.key]);
  return (
    <AppOwnRouter start={start}>
      <AppRoutes app={app} leave={leave} />
    </AppOwnRouter>
  );
}

function AppRoutes({ app, leave }: { app: RegisteredApp; leave: NavigateFunction }) {
  const location = useLocation();
  const place = `${location.pathname}${location.search}${location.hash}`;
  const inApp = isPlaceInApp(app, place);
  useEffect(() => {
    if (!inApp) return;
    try { sessionStorage.setItem(appWindowPlaceKey(app.key), place); } catch { /* quota */ }
  }, [app.key, inApp, place]);
  if (!inApp) return <LeaveApp to={place} leave={leave} />;
  if (app.kind === 'core') return <CoreAppView app={app} />;
  return (
    <Routes>
      <Route path="/apps/:appId/*" element={<AppHostPage />} />
    </Routes>
  );
}

/** A move out of the app: the window's own router takes it (once, StrictMode runs effects twice). */
function LeaveApp({ to, leave }: { to: string; leave: NavigateFunction }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    leave(to);
  }, [to, leave]);
  return null;
}
