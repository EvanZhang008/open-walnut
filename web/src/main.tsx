// MUST be the first import: patches the async dispatchers (timers, rAF,
// MessagePort/WebSocket onmessage) so main-thread blocks self-attribute.
// React's scheduler creates its MessageChannel at react-dom module init, so
// any later install misses it.
import './utils/trace-dispatchers';
// Second: starts loading the app this window shows (App, or a pop-out's own view) while the
// rest of this entry evaluates (boot-shell.ts).
import { isPopoutWindow, loadPluginLoader, shellReady } from './boot-shell';
import { StrictMode, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { ConfirmProvider } from './hooks/useConfirm';
import { initAppInfo } from './utils/app-info';
import { initBrowserLogger } from './utils/browser-logger';
import { initLongTaskMonitor } from './utils/longtask-monitor';
import { initInputLatencyMonitor } from './utils/input-latency-monitor';
import { initMainThreadTracer, startPhase, endPhase, tracePhase } from './utils/main-thread-tracer';
import { initUiPrefsSync, setLatePrefsHost } from './utils/ui-prefs-sync';
import { initDraftSync } from './utils/drafts';
import { pressKeepsSelection, selectionIntersects } from './utils/selection-guard';
import { initSessionStatusStore } from './stores/init-session-status-store';
import { initRecapTipStore } from './stores/recap-tip-store';
import { initTurnSpeedStore } from './stores/turn-speed-store';
import { installGlobalAutofillSuppression } from './utils/no-autofill';
import { installEscapeBeepGuard } from './utils/escape-beep-guard';
import { silenceAutomatedAudio } from './utils/automation-silence';
import { installImageSizeHold } from './utils/image-size-hold';
import { installHighlightRules } from './utils/highlight-rules';
import { installCodeBlockActions } from './utils/code-block-actions';
import { hasUnsavedWork, initStaleAssetRecovery, initStaleBuildUpgrade } from './utils/stale-assets';
import { installDesktopBridge } from './utils/desktop-bridge';
import { installPluginHostRuntime } from './plugins/runtime';
import { installAuthFetch } from './api/auth-fetch';
import { STORAGE_KEY as DEVICE_TOKEN_KEY, startSignInRenewal, syncDeviceCookie } from './api/device-token';
import { getUnpairedState, subscribeUnpaired } from './api/unpaired';
import { hasPendingPairCode } from './api/browser-pair';
import { resolveSignInGate, type SignInGate } from './api/sign-in-gate';
import { UnpairedNotice } from './components/common/UnpairedNotice';
import { installOpenLinks } from './utils/open-link';
import { installOpIdFetch } from './api/op-id';
import { installLeaderPresence } from './hooks/useLeaderPresence';


// A browser under automation (every Playwright run) makes no sound on the machine,
// whatever this page shows (automation-silence.ts).
silenceAutomatedAudio();
// Every same-origin fetch write carries an op id (api/op-id.ts), the raw ones too,
// before anything below sends one.
installOpIdFetch();
// A host replica says whether the Mac answers (hooks/useLeaderPresence.ts): its
// /ws event, its close codes and the headers of every fetch.
installLeaderPresence();
// A signed-in browser on another device sends its token on every /api fetch,
// including the loaders that call fetch() directly, and on every <img>.
installAuthFetch();
syncDeviceCookie();
// An `#open-link=<open-walnut://…>` fragment (the Mac app opening a link, or a
// pasted address): taken out of the address bar now and on every hash change.
installOpenLinks();


// Sign-in first (api/sign-in-gate.ts): a `#pair=` code is traded before the
// console mounts, and a browser that is not signed in gets the sign-in screen
// alone instead of a console whose every request is refused.
// While a `#pair=` code is being traded the sign-in screen shows its pending
// state, until the reload that follows a right one.
// A code kept from a trade that got no answer before a reload counts too.
const signInRoot = hasPendingPairCode() ? createRoot(document.getElementById('root')!) : null;
// Drawn once the stylesheets are in (they load with the app, shellReady), as before the split.
if (signInRoot) void shellReady.catch(() => undefined).then(() => { if (!booted && gateRoot === signInRoot) signInRoot.render(<StrictMode><UnpairedNotice /></StrictMode>); });
// A probe that got no answer (D5) shows the sign-in screen with its error line
// and Try again, and probes again by itself every few seconds: the first answer
// boots the console (or turns the screen into the plain sign-in).
let gateRoot = signInRoot;
let reprobe: ReturnType<typeof setTimeout> | null = null;
let booted = false;
function applyGate(gate: SignInGate): void {
  // A tap and the timed probe can both come back: the console boots once.
  if (booted) return;
  if (reprobe) { clearTimeout(reprobe); reprobe = null; }
  if (gate === 'app') {
    booted = true;
    gateRoot?.unmount();
    gateRoot = null;
    bootApp();
    return;
  }
  gateRoot ??= createRoot(document.getElementById('root')!);
  const failed = gate === 'probe-failed';
  const root = gateRoot;
  void shellReady.catch(() => undefined).then(() => {
    if (booted || gateRoot !== root) return;
    root.render(<StrictMode><UnpairedNotice probeFailed={failed} onRetryProbe={failed ? retryProbe : undefined} /></StrictMode>);
  });
  if (failed) reprobe = setTimeout(() => { void retryProbe(); }, 4_000);
}
async function retryProbe(): Promise<void> {
  applyGate(await resolveSignInGate());
}
void resolveSignInGate().then(applyGate);
// A sign-in link opened in a tab that already shows Walnut changes only the
// fragment, so nothing loads: load the page again and the gate trades the code.
window.addEventListener('hashchange', () => { if (/^#pair=/.test(window.location.hash)) window.location.reload(); });
// Signed out while the console runs (removed on the computer, its cookie gone): the
// console goes, with every task and note it drew and every request it would go on
// making, and the signed-out page stays alone. Signed in again (a refusal undone by
// its recheck): the page loads afresh.
let appRoot: Root | null = null;
let signedOutRoot: Root | null = null;
function leaveConsoleIfSignedOut(): void {
  const now = getUnpairedState();
  if (signedOutRoot) {
    if (now === 'ok') window.location.reload();
    return;
  }
  if (!booted || !appRoot || now !== 'revoked') return;
  appRoot.unmount();
  appRoot = null;
  void import('./api/ws').then(({ wsClient }) => wsClient.disconnect());
  signedOutRoot = createRoot(document.getElementById('root')!);
  signedOutRoot.render(<StrictMode><UnpairedNotice /></StrictMode>);
}
// Also once the console has mounted: a refusal can land while it is still loading.
subscribeUnpaired(() => queueMicrotask(leaveConsoleIfSignedOut));
// This tab shows the sign-in screen (or the signed-out notice) and another tab of
// this browser just signed in: the token is this tab's too.
window.addEventListener('storage', (e) => {
  if (e.key === DEVICE_TOKEN_KEY && e.newValue && (!booted || getUnpairedState() !== 'ok')) window.location.reload();
});

/**
 * The installed plugins' web modules. Their loader reaches every view a plugin may mount (Notes,
 * Calendar, the session panel…), so it is its own chunk: the console loads it at once, a pop-out
 * once its view has drawn (the side panel must not wait on code it does not show first).
 */
function startWebPlugins(): void {
  const start = () => { void loadPluginLoader().then((m) => m.initWebPlugins()); };
  if (!isPopoutWindow) { start(); return; }
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  void shellReady.catch(() => undefined).then(() => {
    if (idle) idle(start, { timeout: 2_000 });
    else setTimeout(start, 500);
  });
}

function bootApp(): void {
  // A browser signed in with a code renews its sign-in before it runs out (api/device-token.ts).
  startSignInRenewal();
  // Persist browser console logs to disk (view with: open-walnut logs -s browser)
  initBrowserLogger();
  installPluginHostRuntime();
  startWebPlugins();
  // Subscribe before React mounts so the first WS status event cannot race ahead
  // of component hooks.
  tracePhase('boot:session-status-store', initSessionStatusStore);
  tracePhase('boot:recap-tip-store', initRecapTipStore);
  tracePhase('boot:turn-speed-store', initTurnSpeedStore);
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
  // How much room a scrollbar takes (`--wn-scrollbar-h`) is published by boot-shell.ts
  // once the global stylesheets are in, before shellReady resolves: code blocks reserve
  // their horizontal track up front and subtract it from their bottom padding.
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
  // A chat image drawn again (a reply's persisted row replacing its stream blocks)
  // keeps its box while it decodes, so nothing around it moves for a frame.
  installImageSizeHold();
  // ::highlight paint rules only for the highlight names registered now (every
  // linked one costs a style per element per recalc). Before mount: the first
  // highlight set already finds its rules.
  installHighlightRules();
  // Copy and Wrap on every rendered code block (utils/code-block-actions.ts), and
  // the saved wrap preference on <html> before the first message paints.
  installCodeBlockActions();

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
  // Unsent drafts too (utils/drafts.ts): every box reads its words in a useState initializer.
  // The app's own code too (shellReady, asked at the top of this file, so it is mostly in by now).
  const shown = shellReady.then((one) => one, (error: unknown) => {
    console.error('[boot] the app failed to load', { error: String((error as Error)?.stack ?? error) });
    // Thrown at render, so the error boundary shows its recovery (and the stale-asset
    // recovery reloads a page whose chunks went away with a deploy).
    return (() => { throw error; }) as ComponentType;
  });
  Promise.all([initUiPrefsSync().catch(() => undefined), initDraftSync().catch(() => undefined), shown]).then(([, , Shell]) => {
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
    const root = createRoot(document.getElementById('root')!, {
      onUncaughtError: logReactError('uncaught render error (root unmounted)'),
      onCaughtError: logReactError('render error caught by boundary'),
    });
    appRoot = root;
    // `generation` keys the whole tree: a new one mounts it again, so every useState
    // initializer reads localStorage afresh (the user's prefs that arrived late).
    const renderApp = (generation: number) => root.render(
      <StrictMode>
        <BrowserRouter key={generation}>
          <ConfirmProvider>
            <AppErrorBoundary>
              <Shell />
            </AppErrorBoundary>
          </ConfirmProvider>
        </BrowserRouter>
      </StrictMode>,
    );
    let generation = 0;
    renderApp(generation);
    // The prefs read at boot timed out and answered later (ui-prefs-sync.ts): mount once more
    // on them, unless that would lose unsaved text or the console has gone (signed out).
    setLatePrefsHost({
      remount: () => { if (appRoot === root) renderApp(++generation); },
      canRemount: () => appRoot === root && !hasUnsavedWork(document, 'reload'),
    });
    queueMicrotask(leaveConsoleIfSignedOut);
  });
}
