/**
 * The App view of the session split: a plugin App's `sessionPane` beside the chat, in the
 * same column Files and Terminal use (sessionSplitView.ts 'app').
 *
 * What the pane keeps is the panel's view (panel-view.ts `app`): which App, and per App the
 * document it showed, so a reload, a plugin reload or a restart opens the same App on the same
 * document. The bar above the App is Walnut's: the App's name (a tab per App when several
 * offer a pane), the chat toggle of the split, and Close. It stays usable whatever the App does,
 * because the App draws below it, inside its own box (PluginBounds) and its own error boundary
 * (PluginBoundary): a crash shows there, and the bar still closes the pane.
 *
 * Identity: the App is mounted once per pane (`paneId`, the panel's place and session), App
 * and registration (`generation`), so another session, another App or a reloaded plugin is a
 * fresh mount and never inherits the last one's state.
 *
 * Focus: the pane takes the focus only when a person opened it (`takeFocus`), never when a
 * kept view mounts it again on a reload, so a restore never pulls the caret out of the composer.
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useNavigate } from 'react-router-dom';
import { PluginBoundary } from '@/components/common/PluginBoundary';
import { ICON_CLOSE } from '@/components/common/Icons';
import { PluginBounds } from '@/plugins/PluginBounds';
import { useWebPluginRuntime } from '@/plugins/runtime-store';
import { useAppCatalog } from '@/apps/hooks';
import { appNavigateTarget, sessionPaneApps, type RegisteredApp, type SessionAppProps } from '@/apps/registry';
import { log } from '@/utils/log';
import type { PanelAppRecord } from './panel-view';
import '@/styles/session-app-pane.css';

export interface SessionPluginAppPaneProps {
  sessionId: string;
  taskId?: string;
  cwd?: string;
  host?: string;
  /** The pane's identity: the panel's place and its session. */
  paneId: string;
  /** The kept App view (null: nothing picked yet, the first offered App shows). */
  record: PanelAppRecord | null;
  onPickApp(key: string): void;
  onDocumentPathChange(key: string, path: string | null): void;
  onClose(): void;
  /** True once per open by a person: the pane then moves the focus into the App. */
  takeFocus(): boolean;
  /** The split's chat toggle, at the bar's right. */
  barRightSlot?: ReactNode;
}

/** A plugin App's icon in a host row, in its own boundary as on the Sidebar: a broken icon draws `fallback`. */
export function PaneAppIcon({ app, size, fallback = null }: { app: RegisteredApp; size: number; fallback?: ReactNode }) {
  const Icon = app.icon;
  if (!Icon) return <>{fallback}</>;
  return (
    <PluginBoundary pluginId={app.pluginId ?? app.owner} pluginName={app.pluginName ?? app.title} resetKey={app.generation} compact fallback={fallback}>
      <Icon size={size} />
    </PluginBoundary>
  );
}

/** The Apps a session panel offers beside its chat (catalogue order, none hidden by the person). */
export function useSessionPaneApps(): RegisteredApp[] {
  const catalog = useAppCatalog();
  return useMemo(() => sessionPaneApps(catalog.discoverable), [catalog.discoverable]);
}

/** The App a kept record names, else the first one offered; never one without a pane. */
export function pickPaneApp(
  record: PanelAppRecord | null,
  offered: RegisteredApp[],
  all: RegisteredApp[],
): { key: string | null; app: RegisteredApp | undefined } {
  const key = record?.key ?? offered[0]?.key ?? null;
  if (!key) return { key: null, app: undefined };
  return { key, app: sessionPaneApps(all).find((candidate) => candidate.key === key) };
}

export function SessionPluginAppPane({
  sessionId, taskId, cwd, host, paneId, record, onPickApp, onDocumentPathChange, onClose, takeFocus, barRightSlot,
}: SessionPluginAppPaneProps) {
  const catalog = useAppCatalog();
  const runtime = useWebPluginRuntime();
  const routerNavigate = useNavigate();
  const offered = useMemo(() => sessionPaneApps(catalog.discoverable), [catalog.discoverable]);
  const { key, app } = pickPaneApp(record, offered, catalog.all);
  // The kept App stays a tab while it shows, even when the person hid it from the Apps page.
  const tabs = app && !offered.some((candidate) => candidate.key === app.key) ? [...offered, app] : offered;
  const loading = !app && !!key && (!runtime.ready || runtime.loading);

  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!app) return;
    // A frame late: the App's own mount effects may focus a control of theirs, which wins.
    // The one-shot wish is taken inside the frame, not here: an effect that runs twice
    // (StrictMode, a remount) cancels its first frame, and taking it here lost it.
    const frame = requestAnimationFrame(() => {
      if (!takeFocus()) return;
      const box = boxRef.current;
      if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per App mounted, not per callback identity
  }, [app?.key, app?.generation]);

  useEffect(() => {
    if (key && !app && !loading) log.warn('session-panel', 'session app pane unavailable', { sessionId, appKey: key });
  }, [key, app, loading, sessionId]);

  const appKey = app?.key;
  const appPath = app?.path;
  const documentPath = appKey ? record?.docs?.[appKey] : undefined;
  const setDocument = useLeanCallback((path: string | null) => {
    if (!appKey) return;
    if (path !== null && typeof path !== 'string') return;
    onDocumentPathChange(appKey, path);
  }, [appKey, onDocumentPathChange]);
  const navigate = useLeanCallback((target: string, options?: { replace?: boolean }) => {
    if (!appPath || typeof target !== 'string') return;
    routerNavigate(appNavigateTarget(appPath, target), options);
  }, [appPath, routerNavigate]);

  const props: SessionAppProps | null = app ? {
    sessionId,
    ...(taskId ? { taskId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(host ? { host } : {}),
    basePath: app.path,
    paneId,
    ...(documentPath ? { documentPath } : {}),
    onDocumentPathChange: setDocument,
    navigate,
    onClose,
  } : null;
  const Pane = app?.sessionPane;

  return (
    <div className="session-app-pane" data-testid="session-app-pane" data-app-key={key ?? undefined}>
      <div className="session-app-pane-bar">
        {tabs.length > 1 ? (
          <div className="session-app-pane-tabs" role="tablist" aria-label="Apps">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={tab.key === key}
                className={`session-app-pane-tab${tab.key === key ? ' is-active' : ''}`}
                data-app-key={tab.key}
                onClick={() => { if (tab.key !== key) onPickApp(tab.key); }}
              >
                <PaneAppIcon app={tab} size={13} />
                <span>{tab.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="session-app-pane-title">
            {app && <PaneAppIcon app={app} size={13} />}
            <span>{app?.title ?? 'App'}</span>
          </span>
        )}
        <div className="session-app-pane-bar-right">
          {barRightSlot}
          <button
            type="button"
            className="sfe-btn session-app-pane-close"
            onClick={onClose}
            aria-label={`Close ${app?.title ?? 'App'}`}
            title="Close (the chat stays)"
            data-testid="session-app-pane-close"
          >{ICON_CLOSE}</button>
        </div>
      </div>
      {app && Pane && props ? (
        <PluginBoundary
          key={app.key}
          pluginId={app.pluginId ?? app.owner}
          pluginName={app.pluginName ?? app.title}
          resetKey={app.generation}
        >
          <PluginBounds
            className="session-app-pane-box"
            data-testid="session-app-pane-box"
            data-app-key={app.key}
            data-plugin-id={app.pluginId}
          >
            <PaneFocusBox boxRef={boxRef} label={app.title}>
              <Pane key={`${paneId}\u0000${app.key}\u0000${app.generation}`} {...props} />
            </PaneFocusBox>
          </PluginBounds>
        </PluginBoundary>
      ) : (
        <div className="session-app-pane-empty" role="status" data-testid="session-app-pane-empty">
          {!key
            ? 'No App offers a pane beside a session.'
            : loading
              ? 'Loading the App…'
              : 'This App is not available: its plugin is off, or it no longer offers a pane beside a session.'}
        </div>
      )}
    </div>
  );
}

/** The element the pane focuses: the App's whole area, named for a screen reader. */
function PaneFocusBox({ boxRef, label, children }: { boxRef: RefObject<HTMLDivElement | null>; label: string; children: ReactNode }) {
  return (
    <div ref={boxRef} className="session-app-pane-focus" tabIndex={-1} role="region" aria-label={label}>
      {children}
    </div>
  );
}
