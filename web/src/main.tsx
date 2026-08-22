import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { ConfirmProvider } from './hooks/useConfirm';
import { initAppInfo } from './utils/app-info';
import { initBrowserLogger } from './utils/browser-logger';
import { initLongTaskMonitor } from './utils/longtask-monitor';
import { initMainThreadTracer, startPhase, endPhase, tracePhase } from './utils/main-thread-tracer';
import { initUiPrefsSync } from './utils/ui-prefs-sync';
import { selectionIntersects } from './utils/selection-guard';
import { initSessionStatusStore } from './stores/init-session-status-store';
import { installGlobalAutofillSuppression } from './utils/no-autofill';
import { initStaleAssetRecovery } from './utils/stale-assets';
import './styles/globals.css';

// Persist browser console logs to disk (view with: open-walnut logs -s browser)
initBrowserLogger();
// Subscribe before React mounts so the first WS status event cannot race ahead
// of component hooks.
tracePhase('boot:session-status-store', initSessionStatusStore);
// Report main-thread blocks >200ms with attribution (rate-limited) — makes
// starvation windows self-identify in the server log.
initLongTaskMonitor();
// Firefox has no `longtask` observer — the lag-sampler tracer covers it and
// attributes blocks to the boot/render phases active at the time.
initMainThreadTracer();
// Cache server version/mode for crash reports (survives to server-down crashes).
initAppInfo();
// A deploy wipes the hashed assets this tab was built against, so its next
// code-split import silently dies (that is how a .go file lost its syntax
// colors mid-session). Reload once the tab has no unsaved text.
initStaleAssetRecovery();
// No login form anywhere in Walnut — suppress password-manager autofill popups
// (iCloud Passwords etc.) on every input/textarea, present and future.
installGlobalAutofillSuppression();

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
