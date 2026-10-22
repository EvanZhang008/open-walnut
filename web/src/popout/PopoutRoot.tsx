import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PopoutFileView } from './PopoutFileView';
import { PopoutGlobalNotes } from './PopoutGlobalNotes';
import { PopoutNote } from './PopoutNote';
import { PopoutSession } from './PopoutSession';
import { PopoutTask } from './PopoutTask';

/**
 * Theme persistence — must stay in sync with web/src/hooks/useTheme.ts.
 * Stored value is 'light' | 'dark' | 'system' under this key. We set
 * documentElement.dataset.theme only for explicit light/dark; for 'system'
 * (or missing) we delete it so the CSS `@media (prefers-color-scheme)`
 * fallback applies — identical to useTheme's applyToDOM().
 */
const THEME_STORAGE_KEY = 'open-walnut-theme';

function applyStoredTheme() {
  let pref: string | null = null;
  try {
    pref = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* private browsing */
  }
  const el = document.documentElement;
  if (pref === 'light' || pref === 'dark') {
    el.dataset.theme = pref;
  } else {
    delete el.dataset.theme;
  }
}

/**
 * Root of a pop-out window. Mounted by App.tsx when the path starts with
 * `/popout`, BEFORE <AppShell>: no sidebar or MainPage. Each leaf mounts the
 * providers its interactions need. Restores the saved theme, then dispatches
 * to the requested leaf view by `?view=`.
 */
export function PopoutRoot() {
  const [params] = useSearchParams();
  const view = params.get('view');

  // useLayoutEffect so the theme is applied before first paint (no flash).
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  let content: ReactNode;
  switch (view) {
    case 'file':
      content = <PopoutFileView />;
      break;
    case 'global-notes':
      content = <PopoutGlobalNotes />;
      break;
    case 'note':
      content = <PopoutNote />;
      break;
    case 'session':
      content = <PopoutSession />;
      break;
    case 'task':
      content = <PopoutTask />;
      break;
    default:
      content = (
        <div className="popout-stub">
          <h2>Unknown view</h2>
          <code>{view || '(none)'}</code>
        </div>
      );
  }

  return <div className="popout-root">{content}</div>;
}
