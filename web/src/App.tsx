import { memo, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { AppHostPage } from './apps/AppHostPage';
import { syncAppCommands } from './apps/commands';
import { ensureCoreAppsRegistered } from './apps/core-apps';
import { useAppCatalog } from './apps/hooks';
import { openSessionOnHome } from './utils/open-session';
import { parseSessionInboxTarget } from './components/inbox/session-inbox-link';
import { AppShell } from './components/layout/AppShell';
import { DebugCrashProbe } from './components/common/AppErrorBoundary';
import { PluginBoundary } from './components/common/PluginBoundary';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { usePluginUi, useWebPluginRuntime } from './plugins/hooks';
import { MainPage } from './pages/MainPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { CommandsPage } from './pages/CommandsPage';
import { SkillsPage } from './pages/SkillsPage';
import { MemoryPage } from './pages/MemoryPage';
import { PopoutRoot } from './popout/PopoutRoot';
import { isPopoutPath } from './popout/openPopout';

ensureCoreAppsRegistered();

const StableMainPage = memo(MainPage);

function SessionsRedirect() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const id = searchParams.get('id');
  useEffect(() => {
    if (!id) { navigate('/', { replace: true }); return; }
    // `&tab=inbox[&letter=…]` on a pasted/bookmarked link lands on the session's
    // Inbox tab, same as clicking "Open session" inside a letter.
    const inbox = parseSessionInboxTarget(searchParams);
    openSessionOnHome(id, (to) => navigate(to, { replace: true }), inbox
      ? { inboxTab: true, ...(inbox.letterId ? { inboxLetterId: inbox.letterId } : {}) }
      : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const pluginUi = usePluginUi();
  const pluginRuntime = useWebPluginRuntime();
  const apps = useAppCatalog();

  useEffect(() => {
    syncAppCommands(apps.discoverable);
  }, [apps.discoverable]);

  if (isPopoutPath(location.pathname)) return <PopoutRoot />;

  const isHome = location.pathname === '/';
  const navigateRef = useRef<NavigateFunction>(navigate);
  navigateRef.current = navigate;

  return (
    <AppShell>
      <DebugCrashProbe />
      <div className={isHome ? 'main-page-wrapper' : 'main-page-wrapper main-page-wrapper-hidden'}>
        <StableMainPage visible={isHome} navigateRef={navigateRef} />
      </div>
      <Routes>
        <Route path="/" element={null} />
        {apps.all.filter((app) => app.kind === 'core' && !app.persistent && app.component).map((app) => {
          const CoreApp = app.component!;
          return (
            <Route
              key={`${app.key}:${app.generation}`}
              path={app.path}
              element={(
                <CoreApp
                  basePath={app.path}
                  subpath=""
                  search={location.search}
                  navigate={(target, options) => navigate(target, options)}
                />
              )}
            />
          );
        })}
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/search" element={<Navigate to="/" replace />} />
        <Route path="/sessions" element={<SessionsRedirect />} />
        <Route path="/cron" element={<Navigate to="/routines" replace />} />
        <Route path="/usage" element={<Navigate to="/settings#usage" replace />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/commands" element={<CommandsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/hooks" element={<Navigate to="/settings#hooks" replace />} />
        <Route path="/repos" element={<Navigate to="/settings#repositories" replace />} />
        {/* The Time UI is the walnut-time Plugin App; the old Settings section it
            used to point at was deleted with the duplicate views. An uninstalled
            App answers with its own "disabled or uninstalled" card, which is a
            better answer than a Settings page with no Time row on it. */}
        <Route path="/time" element={<Navigate to="/apps/walnut-time~main" replace />} />
        <Route path="/timeline" element={<Navigate to="/settings#timeline" replace />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/apps/:appId/*" element={<AppHostPage />} />
        {pluginUi.pages.map((page) => {
          const PluginPage = page.value.component;
          return (
            <Route
              key={`${page.key}:${page.generation}`}
              path={page.value.path}
              element={(
                <PluginBoundary
                  pluginId={page.pluginId}
                  pluginName={page.pluginName}
                  resetKey={page.generation}
                >
                  <div className="plugin-native-page" data-plugin-id={page.pluginId}>
                    <PluginPage />
                  </div>
                </PluginBoundary>
              )}
            />
          );
        })}
        <Route path="*" element={pluginRuntime.ready ? <Navigate to="/" replace /> : <LoadingSpinner />} />
      </Routes>
    </AppShell>
  );
}
