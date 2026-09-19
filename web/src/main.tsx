// MUST be the first import: patches the async dispatchers (timers, rAF,
// MessagePort/WebSocket onmessage) so main-thread blocks self-attribute.
// React's scheduler creates its MessageChannel at react-dom module init, so
// any later install misses it.
import './utils/trace-dispatchers';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { ConfirmProvider } from './hooks/useConfirm';
import { initAppInfo } from './utils/app-info';
import { initBrowserLogger } from './utils/browser-logger';
import { initLongTaskMonitor } from './utils/longtask-monitor';
import { initInputLatencyMonitor } from './utils/input-latency-monitor';
import { initMainThreadTracer, startPhase, endPhase, tracePhase } from './utils/main-thread-tracer';
import { publishScrollbarMetrics } from './utils/scrollbar-metrics';
import { initUiPrefsSync } from './utils/ui-prefs-sync';
import { pressKeepsSelection, selectionIntersects } from './utils/selection-guard';
import { initSessionStatusStore } from './stores/init-session-status-store';
import { initRecapTipStore } from './stores/recap-tip-store';
import { installGlobalAutofillSuppression } from './utils/no-autofill';
import { installEscapeBeepGuard } from './utils/escape-beep-guard';
import { initStaleAssetRecovery, initStaleBuildUpgrade } from './utils/stale-assets';
import { installDesktopBridge } from './utils/desktop-bridge';
import { initWebPlugins } from './plugins/loader';
import { installPluginHostRuntime } from './plugins/runtime';
import './styles/globals.css';

// Persist browser console logs to disk (view with: open-walnut logs -s browser)
initBrowserLogger();
installPluginHostRuntime();
void initWebPlugins();
// Subscribe before React mounts so the first WS status event cannot race ahead
// of component hooks.
tracePhase('boot:session-status-store', initSessionStatusStore);
tracePhase('boot:recap-tip-store', initRecapTipStore);
// Report main-thread blocks >200ms with attribution (rate-limited) — makes
// starvation windows self-identify in the server log.
initLongTaskMonitor();
// Firefox has no `longtask` observer — the lag-sampler tracer covers it and
// attributes blocks to the boot/render phases active at the time.
initMainThreadTracer();
// Keystroke → paint latency per 30s window, tagged mac-app vs browser, so
// "typing feels laggy" is a number in the server log, not a description.
initInputLatencyMonitor();
// Cache server version/mode for crash reports (survives to server-down crashes).
initAppInfo();
// Publish how much room a scrollbar takes (`--wn-scrollbar-h`). Code blocks
// reserve their horizontal track up front and subtract this from their bottom
// padding, so the reserved strip cannot double as dead space. Before mount: the
// first painted code block should already have the right padding.
publishScrollbarMetrics();
// A deploy replaces the build this tab runs. The server keeps the old build's
// chunks servable so nothing breaks under a click; this pair moves the tab onto
// the new build at a quiet moment (hidden tab after the reconnect a deploy
// causes) and, as the backstop, reloads if a chunk is genuinely gone — never
// on top of unsaved text either way.
initStaleAssetRecovery();
initStaleBuildUpgrade();
// The Mac app shell asks this before it swaps the page process for a fresh one
// (memory watchdog / newer bundle), so it applies the same unsaved-text rule.
installDesktopBridge();
// No login form anywhere in Walnut — suppress password-manager autofill popups
// (iCloud Passwords etc.) on every input/textarea, present and future.
installGlobalAutofillSuppression();
// The Mac app is a WKWebView: an Escape nobody preventDefault()s reaches AppKit
// and NSBeeps. The guard swallows that default only once the page is finished
// with the key, so `defaultPrevented` stays honest for in-page handlers (the
// editors skip their own Escape bindings when it is set). Installed here, before
// the app mounts, so its window-bubble listener runs ahead of every app handler's.
installEscapeBeepGuard();

// Clear text selection instantly on mousedown to avoid macOS inactive-selection pink flash.
// Scoped (was unconditional, which broke copy entirely): never on right/middle click —
// the context menu needs the selection alive for "Copy" — and never when the click
// lands inside the selection itself (drag-of-selected-text, copy affordances).
// Inside-selection clicks are cleared by the BROWSER on mouseup (native collapse
// when a click lands in a selection without dragging) — this handler only owns
// the outside-click instant-clear; don't "complete" it or right-click Copy breaks.
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  if (e.target instanceof Node && selectionIntersects(e.target)) return;
  // …and never on a control that opts out (`data-keep-selection`): the mic, where
  // the press IS the user acting on the passage they just selected. This handler
  // was measured deselecting it the instant they reached for voice input.
  if (pressKeepsSelection(e.target)) return;
  sel.removeAllRanges();
}, true);

// Seed layout prefs (collapse states, splitter positions) from the server
// BEFORE first render — components read them in useState initializers.
// Never throws; offline just falls back to plain localStorage.
startPhase('boot:ui-prefs-sync');
initUiPrefsSync().finally(() => {
  endPhase('boot:ui-prefs-sync');
  startPhase('boot:react-mount');
  // react-mount phase ends on the first post-render macrotask — everything
  // between is the synchronous initial render + effects of the whole tree.
  setTimeout(() => endPhase('boot:react-mount'), 0);
  // onUncaughtError / onCaughtError: React 19 reports render errors via
  // window.reportError by default — which bypasses the console monkey-patch, so
  // crashes never reached the server log. Route them through console.error.
  const logReactError = (label: string) => (error: unknown, errorInfo: { componentStack?: string | null }) => {
    console.error(`[react] ${label}`, {
      error: String((error as Error)?.stack ?? error),
      componentStack: (errorInfo?.componentStack ?? '').slice(0, 2000),
    });
  };
  createRoot(document.getElementById('root')!, {
    onUncaughtError: logReactError('uncaught render error (root unmounted)'),
    onCaughtError: logReactError('render error caught by boundary'),
  }).render(
    <StrictMode>
      <BrowserRouter>
        <ConfirmProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ConfirmProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
