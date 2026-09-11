/**
 * "Walnut updated · Reload" — the visible half of the stale-build story.
 *
 * `initStaleBuildUpgrade` can only heal a tab silently while nobody is looking.
 * The Mac app's window is looked at for hours, so silence there meant the user
 * spent an evening on a bundle six deploys old (2026-09-09) with no way to know.
 * This pill is what "we could not fix it quietly" looks like: small, bottom
 * centre, above the composer, dismissible, and never reloading on its own.
 *
 * Two rules it inherits from stale-assets.ts, both shipped incidents:
 *  - never reload under the user: the reload happens on a CLICK, not a timer;
 *  - never reload over unsaved text: with a draft in flight the first click only
 *    changes the label and asks again, so a half-written message needs a
 *    deliberate second click to be thrown away.
 *
 * Portalled to <body> because a `contain: paint` ancestor (the file viewer, a
 * fullscreen panel) turns `position: fixed` into "fixed inside that box".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getStaleBuild,
  hasUnsavedWork,
  reloadForUpgrade,
  subscribeStaleBuild,
  type StaleBuildState,
} from '@/utils/stale-assets';

/** Holds the served bundle the user waved away. A NEWER deploy is a new
 *  question, so the pill asks again; a reload clears it either way. */
const DISMISS_KEY = 'open-walnut-stale-build-pill-dismissed';
/** How long the "reload anyway?" question stays armed before it reverts. */
const CONFIRM_MS = 8_000;

function readDismissed(): string | null {
  try { return window.sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function StaleBuildPill() {
  const [state, setState] = useState<StaleBuildState | null>(getStaleBuild);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    // Re-read on mount: the drift can be published before React gets here.
    setState(getStaleBuild());
    return subscribeStaleBuild(() => setState(getStaleBuild()));
  }, []);

  useEffect(() => () => {
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
  }, []);

  const onReload = useCallback(() => {
    if (!confirming && hasUnsavedWork()) {
      setConfirming(true);
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null;
        setConfirming(false);
      }, CONFIRM_MS);
      return;
    }
    reloadForUpgrade();
  }, [confirming]);

  const onLater = useCallback(() => {
    const served = state?.served ?? '1';
    try { window.sessionStorage.setItem(DISMISS_KEY, served); } catch { /* quota */ }
    setDismissed(served);
  }, [state]);

  if (!state || dismissed === state.served) return null;

  return createPortal(
    <div
      className={`stale-build-pill${confirming ? ' is-confirming' : ''}`}
      role="status"
      aria-live="polite"
      data-served={state.served}
      data-running={state.running}
    >
      <span className="stale-build-pill-text">
        {confirming ? 'You have unsaved text — reload anyway?' : 'Walnut updated'}
      </span>
      <span className="stale-build-pill-sep" aria-hidden="true">·</span>
      <button type="button" className="stale-build-pill-action" onClick={onReload}>
        {confirming ? 'Reload anyway' : 'Reload'}
      </button>
      <button
        type="button"
        className="stale-build-pill-later"
        onClick={onLater}
        title="Later — hide until the next reload"
        aria-label="Later — hide until the next reload"
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
