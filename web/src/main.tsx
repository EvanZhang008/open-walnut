import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ConfirmProvider } from './hooks/useConfirm';
import { initBrowserLogger } from './utils/browser-logger';
import { initUiPrefsSync } from './utils/ui-prefs-sync';
import './styles/globals.css';

// Persist browser console logs to disk (view with: open-walnut logs -s browser)
initBrowserLogger();

// Clear text selection instantly on mousedown to avoid macOS inactive-selection pink flash
document.addEventListener('mousedown', () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
}, true);

// Seed layout prefs (collapse states, splitter positions) from the server
// BEFORE first render — components read them in useState initializers.
// Never throws; offline just falls back to plain localStorage.
initUiPrefsSync().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
