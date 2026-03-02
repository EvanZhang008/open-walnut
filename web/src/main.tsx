import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/globals.css';

// Clear text selection instantly on mousedown to avoid macOS inactive-selection pink flash
document.addEventListener('mousedown', () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
}, true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
