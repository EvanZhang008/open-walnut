/**
 * Whether the cloud companion takes over while this Mac is away
 * (`cloud_bridge.backup_leader`, docs/plan/walnut-control-plane.md). One row:
 * the switch answers the click at once, the save follows, a failed save puts
 * it back and says why.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../../SettingsSection';
import { ToggleSwitch } from '../../inputs/ToggleSwitch';
import { saveErrorMessage } from '../../settings-pane-context';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function BackupLeaderGroup({ config, onSave }: Props) {
  const saved = config.cloud_bridge?.backup_leader !== false;
  const [on, setOn] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOn(saved); }, [saved]);

  const flip = async (next: boolean) => {
    setOn(next);
    setError(null);
    setBusy(true);
    try {
      await onSave({ cloud_bridge: { ...(config.cloud_bridge ?? {}), backup_leader: next } } as Partial<Config>);
    } catch (err) {
      log.warn('settings', 'backup leader setting not saved', { error: err instanceof Error ? err.message : String(err) });
      setOn(!next);
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup heading="While this Mac is away">
      <SettingsRow
        label="Cloud companion takes over"
        htmlFor="devices-backup-leader"
        help="Your other hosts keep reaching each other through it while this Mac sleeps; this Mac takes back over when it wakes."
        error={error ?? undefined}
        control={<ToggleSwitch id="devices-backup-leader" checked={on} busy={busy} onChange={(v) => { void flip(v); }} />}
      />
    </SettingsGroup>
  );
}
