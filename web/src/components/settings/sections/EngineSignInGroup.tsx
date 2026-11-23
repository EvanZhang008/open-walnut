/**
 * Settings > Sessions, "<Engine> sign-in" (below "Engines in the model picker"): one row per host
 * Walnut knows, this machine first, each saying whether the engine's CLI there is signed in, how,
 * or not installed, with the one step that fixes it (EngineSignInRow). Always shown: the picker's
 * tick only decides whether the picker offers the engine, while a sign-in belongs to the host and
 * an older session there still needs it. Opening it dials no host (the server lists the open links
 * only); a host not connected reads so until its row is checked.
 */
import { useCallback, useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { log } from '@/utils/log';
import { engineSignInHosts, type EngineSignInStatus } from '@/api/engine-sign-in';
import { EngineSignInRow } from './EngineSignInRow';
import { EngineApiKeyRow } from './EngineApiKeyRow';
import { ENGINE_SIGN_IN_UI, expireSignInRequest, settingsKeySet, signInGroupId, useSignInRequest, type SignInEngine } from './engine-sign-in-model';

export function EngineSignInGroup({ engine }: { engine: SignInEngine }) {
  const ui = ENGINE_SIGN_IN_UI[engine];
  const [hosts, setHosts] = useState<EngineSignInStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useSignInRequest();
  const [keyFocus, setKeyFocus] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await engineSignInHosts(engine);
      setHosts(r.hosts);
      setError(null);
      // The chat's ask for a host this list does not hold ends here (it never starts a sign-in later).
      if (expireSignInRequest(engine, r.hosts)) log.info('settings', 'engine sign-in link named no listed host: dropped', { engine });
    } catch (err) {
      log.warn('settings', 'engine sign-in hosts read failed', { engine, error: String(err) });
      setError(`Could not read the hosts: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [engine]);
  useEffect(() => { void load(); }, [load]);

  const onStatus = useCallback((s: EngineSignInStatus) => {
    setHosts((prev) => prev?.map((h) => (h.host === s.host ? s : h)) ?? prev);
  }, []);

  return (
    <SettingsGroup
      id={signInGroupId(engine)}
      heading={`${ui.name} sign-in`}
      description={`${ui.name} signs in once on each machine; its sessions there use that sign-in.`}
      data-testid={`engine-sign-in-group-${engine}`}
    >
      {hosts?.map((s) => (
        <EngineSignInRow key={s.host} engine={engine} status={s} onStatus={onStatus} onUseKey={() => setKeyFocus((n) => n + 1)} request={request} />
      ))}
      {/* The key is one setting for every machine: one row, after the machines. */}
      {hosts && hosts.length > 0 && (
        <EngineApiKeyRow engine={engine} set={settingsKeySet(hosts)} host={hosts[0]!.host} onChanged={() => void load()} focusNonce={keyFocus} />
      )}
      {!hosts && !error && <SettingsRow label="Reading the hosts..." />}
      {error && (
        <SettingsRow
          label="Hosts not read"
          error={error}
          control={<SettingsButton onClick={() => void load()} busy={loading} busyLabel="Reading...">Try again</SettingsButton>}
        />
      )}
    </SettingsGroup>
  );
}
