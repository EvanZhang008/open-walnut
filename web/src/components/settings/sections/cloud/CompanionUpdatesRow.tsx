/**
 * Whether the cloud companion runs this Mac's build (`cloud_bridge.auto_update`,
 * docs/plan/walnut-companion-unified-replica.md, stage 1). One row: a sentence
 * for where the update stands, Retry after a failure, and the switch. The
 * server has no event for this, so the row reads it again every 10 s while the
 * page is visible, and on every config change.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getCompanionBuild,
  retryCompanionBuild,
  setCompanionAutoUpdate,
  type CompanionBuildView,
} from '@/api/companion-build';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { ToggleSwitch } from '../../inputs/ToggleSwitch';
import { saveErrorMessage } from '../../settings-pane-context';
import { companionUpdatesSentence } from './companion-updates-copy';

const POLL_MS = 10_000;

export function CompanionUpdatesRow() {
  const [view, setView] = useState<CompanionBuildView | null>(null);
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((next: CompanionBuildView) => {
    setView(next);
    setOn(next.autoUpdate);
  }, []);

  const refresh = useCallback(async (background: boolean) => {
    try {
      adopt(await getCompanionBuild({ background }));
    } catch (err) {
      // A server without the route (a replica's console) shows no row at all.
      log.warn('cloud-companion', 'companion build state not read', { error: err instanceof Error ? err.message : String(err) });
    }
  }, [adopt]);

  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEvent('config:changed', () => { void refresh(true); });

  const flip = async (next: boolean) => {
    setOn(next);
    setError(null);
    setBusy(true);
    try {
      adopt(await setCompanionAutoUpdate(next));
      log.info('cloud-companion', 'companion auto update changed', { autoUpdate: next });
    } catch (err) {
      log.warn('cloud-companion', 'companion auto update not saved', { error: err instanceof Error ? err.message : String(err) });
      setOn(!next);
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setError(null);
    setBusy(true);
    try {
      adopt(await retryCompanionBuild());
      log.info('cloud-companion', 'companion build retry', { mine: view?.mine ?? null });
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  return (
    <SettingsRow
      label="Updates"
      htmlFor="cloud-companion-auto-update"
      help={companionUpdatesSentence(view)}
      error={error ?? undefined}
      data-testid="cloud-companion-updates"
      data-update-state={view.state}
      control={(
        <>
          {view.state === 'failed' && (
            <SettingsButton disabled={busy} onClick={() => { void retry(); }} data-testid="cloud-companion-update-retry">
              Retry
            </SettingsButton>
          )}
          <ToggleSwitch
            id="cloud-companion-auto-update"
            aria-label="Keep the companion on this Mac's build"
            checked={on}
            busy={busy}
            onChange={(v) => { void flip(v); }}
          />
        </>
      )}
    >
      {view.state === 'failed' && view.logTail && (
        <details className="cloud-companion-update-log">
          <summary>Install log</summary>
          <pre className="settings-mono-block" style={{ maxHeight: 200 }} tabIndex={0}>{view.logTail}</pre>
        </details>
      )}
    </SettingsRow>
  );
}
