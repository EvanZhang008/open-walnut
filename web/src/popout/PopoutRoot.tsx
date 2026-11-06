import { lazy, Suspense, useLayoutEffect } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isPopoutView, loadPopoutView, loadedPopoutView } from './popout-views';
import { setUpdateNoticeDock, useUpdateNoticeOccupied } from '@/components/common/update-notice-dock';

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
 * The component a view renders with, picked once per view so it never changes type (a change
 * would remount the view): the loaded component when main.tsx's import has landed (the usual
 * case, drawn in the first render), else a lazy one that suspends until it does.
 */
const viewComponents = new Map<string, ComponentType>();
function viewComponent(view: string): ComponentType {
  let c = viewComponents.get(view);
  if (!c) {
    c = loadedPopoutView(view) ?? lazy(() => loadPopoutView(view)!.then((one) => ({ default: one })));
    viewComponents.set(view, c);
  }
  return c;
}

/**
 * Root of a pop-out window. Mounted by PopoutShell.tsx (main.tsx loads it instead
 * of App for a `/popout` address; App mounts it too for a window that navigated
 * there), BEFORE any <AppShell>: no sidebar or MainPage. Each leaf mounts the
 * providers its interactions need. Restores the saved theme, then dispatches
 * to the requested leaf view by `?view=`, each its own chunk (popout-views.ts).
 */
export function PopoutRoot() {
  const [params] = useSearchParams();
  const view = params.get('view');
  const noticeShown = useUpdateNoticeOccupied();

  // useLayoutEffect so the theme is applied before first paint (no flash).
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  let content: ReactNode;
  if (isPopoutView(view)) {
    const View = viewComponent(view);
    content = <Suspense fallback={null}><View /></Suspense>;
  } else {
    content = (
      <div className="popout-stub">
        <h2>Unknown view</h2>
        <code>{view || '(none)'}</code>
      </div>
    );
  }

  // The update notice docks at the bottom, in the flow, so it covers neither the transcript nor the composer.
  return (
    <div className={`popout-root${noticeShown ? ' has-update-notice' : ''}`}>
      {content}<div className="popout-update-dock" ref={setUpdateNoticeDock} />
    </div>
  );
}
