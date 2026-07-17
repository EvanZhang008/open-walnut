import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { ConfirmProvider } from './hooks/useConfirm';
import { initAppInfo } from './utils/app-info';
import { initBrowserLogger } from './utils/browser-logger';
import { initLongTaskMonitor } from './utils/longtask-monitor';
import { initUiPrefsSync } from './utils/ui-prefs-sync';
import './styles/globals.css';

// Persist browser console logs to disk (view with: open-walnut logs -s browser)
initBrowserLogger();
// Report main-thread blocks >200ms with attribution (rate-limited) — makes
// starvation windows self-identify in the server log.
initLongTaskMonitor();
// Cache server version/mode for crash reports (survives to server-down crashes).
initAppInfo();

// Clear text selection instantly on mousedown to avoid macOS inactive-selection pink flash
document.addEventListener('mousedown', () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
}, true);

// Seed layout prefs (collapse states, splitter positions) from the server
// BEFORE first render — components read them in useState initializers.
// Never throws; offline just falls back to plain localStorage.
initUiPrefsSync().finally(() => {
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
