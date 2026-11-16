/**
 * The first Cmd+N after a page load ran the new-task panel's code for the first time: the
 * engine compiled it then, so that one press cost several times the next (2026-11-16, task
 * 9bceb9f2: 76 to 85 ms against about 20 on Chromium, 370 to 460 ms at a 4x slower CPU).
 * The page reloads after every deploy, so the user met that cold press many times a day.
 *
 * Once the page is idle after load, this renders one empty draft panel inside a hidden
 * <Activity>, then unmounts it. A hidden Activity renders but mounts no effects, so the panel
 * subscribes to nothing, fetches nothing and saves no draft; it only runs (and so compiles)
 * the render code the real column will run. It renders into a node that is never in the
 * document, so no selector, focus move or page count meets it. Once per page load: Home
 * mounts it again on every return, and the code is warm by then.
 */
import { Activity, memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DraftSessionPanel } from './DraftSessionPanel';
import type { DraftColumn } from './draft-column';
import { freshLauncherMeta } from './task-meta-constants';

/** Idle wait: Safari (the Mac app's WKWebView) has no requestIdleCallback. */
const FALLBACK_DELAY_MS = 4_000;
/** The hidden panel goes once React's offscreen pass has drawn it, checked this often; while it
 *  stays, every task update draws it again (13 times in 3 s in the budget spec), so it stays no
 *  longer than that, and at most MAX_HOLD_MS when the pass never comes. */
const CHECK_MS = 100;
const MAX_HOLD_MS = 5_000;

const WARM_DRAFT: DraftColumn = { id: 'draft:warmup', cwd: '', host: null, openedCwd: '', openedHost: null, meta: freshLauncherMeta() };
const noop = () => {};
const startNothing = async () => false;
const knownNever = () => false;
let warmedThisLoad = false;
/** Set by the hidden render itself (a hidden Activity runs no effect to say so): React renders
 *  the panel's whole subtree before the sibling after it, so this marks the end of that pass. */
let drawnHidden = false;
function MarkDrawn() {
  drawnHidden = true;
  return null;
}

/** memo: Home redraws often, and the hidden panel needs to render only once. */
export const DraftPanelWarmup = memo(function DraftPanelWarmup() {
  const [phase, setPhase] = useState<'wait' | 'warm' | 'done'>(() => (warmedThisLoad ? 'done' : 'wait'));
  const [host] = useState(() => document.createElement('div'));
  useEffect(() => {
    if (phase === 'done') return;
    if (phase === 'warm') {
      const since = Date.now();
      const t = setInterval(() => {
        if (!drawnHidden && Date.now() - since < MAX_HOLD_MS) return;
        warmedThisLoad = true;
        setPhase('done');
      }, CHECK_MS);
      return () => clearInterval(t);
    }
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setPhase('warm'), { timeout: FALLBACK_DELAY_MS * 2 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setPhase('warm'), FALLBACK_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase !== 'warm') return null;
  return (
    <Activity mode="hidden">
      {createPortal(
        <>
        <DraftSessionPanel
          draft={WARM_DRAFT}
          onStart={startNothing}
          onSaveAsTask={noop}
          onClose={noop}
          onPathChange={noop}
          onProjectChange={noop}
          onMetaChange={noop}
          isKnownProject={knownNever}
        />
        <MarkDrawn />
        </>,
        host,
      )}
    </Activity>
  );
});
