/**
 * Drives the Mac app shell's update by itself (rules in app-auto-update.ts):
 * download when `updates.auto` is on, restart once the server says nobody has
 * been active for a while and no window holds unsaved work. Mounted by the
 * update notice, which already holds the shell state and its actions.
 */
import { useEffect, useRef, useState } from 'react';
import type { LiveUpdate } from '@/api/update';
import type { AppUpdateState } from '@/hooks/useAppUpdate';
import { refreshUpdateStatus } from '@/hooks/useUpdateStatus';
import { log } from '@/utils/log';
import { draftsSettled, type HomeOpener } from '@/utils/unsaved-work';
import { gatherUnsavedWork, hasAny } from '@/components/common/UnsavedWorkDialog';
import { downloadRetryAt, nextAutoStep, readClaim, readLastRestart, readTries, takeClaim, writeLastRestart, writeTries } from './app-auto-update';

/** While a download waits for the idle gate, read the server's gate this often (one local GET). */
const IDLE_POLL_MS = 60_000;

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function useAppAutoUpdate(
  shell: AppUpdateState | null,
  live: LiveUpdate | null | undefined,
  run: (opts?: { checked?: boolean; force?: boolean; auto?: boolean }) => Promise<void>,
  openHome: HomeOpener,
): void {
  const done = useRef(new Set<string>());
  const owner = useRef(`w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);
  const busy = useRef(false);
  // Bumped while a download waits: re-reads the idle gate and decides again (unsaved work may be gone).
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const openHomeRef = useRef(openHome);
  openHomeRef.current = openHome;

  const store = localStore();
  const tried = readTries(store);
  const step = nextAutoStep({
    shell, live, done: done.current, tried, claim: readClaim(store), lastRestart: readLastRestart(store), owner: owner.current, now: Date.now(),
  });
  // A try counts in the key, so the same version's next try after a failure runs the effect again.
  const stepKey = step ? `${step.step}:${step.version}:${tried?.version === step.version ? tried.tries : 0}` : null;

  useEffect(() => {
    if (!step || busy.current) return;
    busy.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (step.step === 'restart') {
          // Every window is asked (the shell answers for the others); any unsaved line holds it,
          // and so does a shell that did not answer (-1: the other windows count as unchecked).
          const work = await gatherUnsavedWork('app', openHomeRef.current, -1);
          if (cancelled || hasAny(work)) return;
          if (!takeClaim(localStore(), step, owner.current, Date.now())) return;
          done.current.add(`restart:${step.version}`);
          writeLastRestart(localStore(), step.version, Date.now());
          log.info('app-update', 'restarting into the downloaded update by itself (idle, nothing unsaved)', { version: step.version });
          await draftsSettled(1_500, work.otherWindows > 0);
          await runRef.current({ checked: true, force: work.allChecked, auto: true });
        } else {
          if (!takeClaim(localStore(), step, owner.current, Date.now())) return;
          const before = readTries(localStore());
          const tries = (before?.version === step.version ? before.tries : 0) + 1;
          writeTries(localStore(), { version: step.version, tries, at: Date.now() });
          log.info('app-update', 'downloading the app update by itself (updates.auto on)', { version: step.version, try: tries });
          await runRef.current({ auto: true });
          // The backoff counts from when this try ended: a slow download that fails does not go again at once.
          writeTries(localStore(), { version: step.version, tries, at: Date.now() });
        }
      } catch (err) {
        log.warn('app-update', 'automatic update step failed', { step: step.step, version: step.version, error: String(err) });
      } finally {
        busy.current = false;
      }
    })();
    return () => { cancelled = true; };
    // stepKey carries `step`; `tick` decides again after a hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, tick]);

  // A failed download waits its backoff (the shell is back on available, or on a download error);
  // nothing else re-renders when it runs out, so a timer decides again.
  const offered = shell?.enabled && live?.updatesAuto && shell.availableVersion
    && (shell.status === 'available' || (shell.status === 'error' && shell.errorContext === 'download')) ? shell.availableVersion : null;
  const retryAt = offered ? downloadRetryAt(tried, offered) : 0;
  useEffect(() => {
    if (!retryAt || !Number.isFinite(retryAt)) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, retryAt - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  // Downloaded, not restarted yet: the server pushes its own steps, not every idle tick, and
  // unsaved work that held the restart may be gone. Read the gate again now and then.
  const waiting = !!shell?.enabled && shell.status === 'downloaded' && !!live?.updatesAuto;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void refreshUpdateStatus(true).finally(() => setTick((n) => n + 1));
    }, IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting]);
}
