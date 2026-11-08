/**
 * The app this window shows, asked for the moment the entry starts to evaluate: main.tsx imports
 * this module second, so the chunks download while the rest of the entry evaluates (they run only
 * after it, so main.tsx's fetch and sign-in hooks are in place before any of their code does).
 *
 * A pop-out window (`/popout?view=…`, the browser extension's side panel on every open) gets its
 * own shell and its one view, never the whole console (Home, the apps, every page), which took
 * about 700 ms to evaluate there (popout/popout-views.ts). Every other address gets App, as before.
 *
 * The global stylesheets come last, after the app's own: in one bundle they followed every
 * component's styles, and a rule of theirs must keep winning over a component rule as specific
 * as it (styles/global-styles.ts).
 */
import type { ComponentType } from 'react';
import { isPopoutPath } from './popout/openPopout';
import { loadPopoutView, popoutViewOf } from './popout/popout-views';
import { publishScrollbarMetrics } from './utils/scrollbar-metrics';

export const shellPath = window.location.pathname;
export const isPopoutWindow = isPopoutPath(shellPath);

let pluginLoader: Promise<typeof import('./plugins/loader')> | null = null;

/**
 * The dev server only (the browser specs run on it): the console page's load event waits for the
 * app's own modules, as it did while main.tsx imported App statically. A dynamic import never
 * holds the load event, so without this `load` fired about half a second in while the app's
 * modules still came in for seconds, and every spec that waits for a page to load and then gives
 * the page 5 s (page.goto, page.reload) had that time eaten (2026-11-06: 0.3 to 0.6 s to `load`,
 * 4.5 to 8 s to the sidebar; with the static import: 3 to 5 s, then 0.5 s). A pending module script
 * holds it: dev-load-hold.ts, which imports App and the plugin loader by the specifiers used below,
 * so they are the same modules, fetched and run once, after this entry as the imports would.
 * A pop-out is left as it is (its view draws on its own clock, and the extension never waits for
 * its frame's load). A build loads its few chunks at once and has no such script.
 */
function holdLoadForApp(): void {
  if (!import.meta.env.DEV || isPopoutWindow || document.readyState === 'complete') return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = import.meta.url.replace(/[^/]*$/, 'dev-load-hold.ts');
  document.head.appendChild(script);
}

export const shellReady: Promise<ComponentType> = (() => {
  const app = isPopoutWindow
    ? (() => {
      // The view's own chunk first (its styles before the shell's, as in one bundle), then the shell.
      const view = loadPopoutView(popoutViewOf(window.location.search));
      const shell = import('./popout/PopoutShell').then((m) => m.PopoutShell as ComponentType);
      return view ? Promise.all([shell, view.catch(() => null)]).then(([s]) => s) : shell;
    })()
    : import('./App').then((m) => m.App as ComponentType);
  // The console's plugin loader rides with App (its styles before the global ones, as in one
  // bundle); a pop-out asks for it once its view has drawn (main.tsx startWebPlugins).
  if (!isPopoutWindow) pluginLoader = import('./plugins/loader');
  // A build links each chunk's stylesheets when its import is asked, so asking now puts the
  // global ones after the app's. Vite's dev server adds a module's styles when the module runs
  // instead, so there they are asked once the app's modules have run (the browser specs run on it).
  const styles = import.meta.env.DEV
    ? Promise.allSettled([app, pluginLoader]).then(() => import('./styles/global-styles'))
    : import('./styles/global-styles');
  holdLoadForApp();
  // The scrollbar's room is measured once the global stylesheets are in: their
  // `::-webkit-scrollbar` rule is what gives WebKit and Chromium a 6px track, and a probe
  // read before it measures the engine's own scrollbar (0 where it overlays), so code blocks
  // reserved 6px and subtracted nothing (2026-11-06 to 11-08, after the stylesheets moved here).
  // Before shellReady resolves, so every first render already has the right padding.
  return Promise.all([app, styles]).then(([one]) => { publishScrollbarMetrics(); return one; });
})();

/** The plugin loader's module (its web modules' host), asked once. */
export function loadPluginLoader(): Promise<typeof import('./plugins/loader')> {
  pluginLoader ??= import('./plugins/loader');
  return pluginLoader;
}
