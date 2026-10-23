/**
 * What the cloud companion keeps (`cloud_bridge.keep`, `cloud_bridge.copies`;
 * docs/plan/walnut-companion-unified-replica.md, 4f): the same rows and defaults as a
 * host's (Remote Hosts), every one on. What it does not keep is answered by this Mac.
 * A switch answers the click at once and saves; a failed save puts it back and says why,
 * beside the half that changed. The leave-out box saves when it loses focus or takes Enter.
 */
import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../../SettingsSection';
import { saveErrorMessage } from '../../settings-pane-context';
import { ReplicaKeepRows, normalizeKeep, splitKeepEntries, type ReplicaKeep } from '../ReplicaKeepRows';
import { ReplicaCopyRows } from '../ReplicaCopyRows';
import { copyChoiceOf, type HostCopyChoice } from '../host-servers-status';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

type Bridge = NonNullable<Config['cloud_bridge']>;

const excludeOf = (keep: ReplicaKeep | undefined): string => (keep?.notes_exclude ?? []).join(', ');

export function CompanionKeepGroup({ config, onSave }: Props) {
  const savedKeep = config.cloud_bridge?.keep;
  const savedCopies = config.cloud_bridge?.copies;
  const savedKey = JSON.stringify([savedKeep ?? null, savedCopies ?? null]);
  const [keep, setKeep] = useState<ReplicaKeep>(savedKeep ?? {});
  const [copies, setCopies] = useState<Partial<HostCopyChoice>>(savedCopies ?? {});
  const [excludeText, setExcludeText] = useState(excludeOf(savedKeep));
  const [busy, setBusy] = useState(false);
  /** A failed save's words, shown beside the half it changed. */
  const [error, setError] = useState<{ at: 'keep' | 'copies'; message: string } | null>(null);
  /** Saves on their way: the config they echo back is older than the choice shown, so it is not applied. */
  const pending = useRef(0);
  /** The leave-out box holds text not saved yet: an echo never replaces it. */
  const typing = useRef(false);
  /** A save of this batch failed: once the last one settles, the saved choice is shown again. */
  const failed = useRef(false);
  const saved = useRef({ keep: savedKeep, copies: savedCopies });
  saved.current = { keep: savedKeep, copies: savedCopies };
  const showSaved = () => {
    setKeep(saved.current.keep ?? {});
    setCopies(saved.current.copies ?? {});
    if (!typing.current) setExcludeText((text) => (splitKeepEntries(text).join(', ') === excludeOf(saved.current.keep) ? text : excludeOf(saved.current.keep)));
  };
  // A save elsewhere (another tab, config.yaml) shows here.
  useEffect(() => {
    if (pending.current === 0) showSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  // Both halves go in every save, from the latest choice: two quick clicks never undo each other.
  const latest = useRef({ keep, copies });
  latest.current = { keep, copies };

  const offOnly = (c: Partial<HostCopyChoice>): Partial<HostCopyChoice> | undefined => {
    const off = Object.fromEntries(Object.entries(copyChoiceOf(c)).filter(([, v]) => v === false));
    return Object.keys(off).length > 0 ? off : undefined;
  };

  const save = async (at: 'keep' | 'copies', next: { keep: ReplicaKeep; copies: Partial<HostCopyChoice> }, undo: () => void) => {
    latest.current = next;
    setError(null);
    setBusy(true);
    pending.current += 1;
    try {
      // Only what differs from "keep everything" is written.
      const bridge: Bridge = { ...(config.cloud_bridge ?? {}), keep: normalizeKeep(next.keep), copies: offOnly(next.copies) };
      await onSave({ cloud_bridge: bridge } as Partial<Config>);
    } catch (err) {
      log.warn('settings', 'companion keep setting not saved', { error: err instanceof Error ? err.message : String(err) });
      undo();
      failed.current = true;
      setError({ at, message: saveErrorMessage(err) });
    } finally {
      pending.current -= 1;
      if (pending.current === 0) {
        setBusy(false);
        if (failed.current) { failed.current = false; showSaved(); }
      }
    }
  };

  const onKeep = (patch: Partial<ReplicaKeep>) => {
    // The typed list rides along with the switch.
    typing.current = false;
    const before = latest.current.keep;
    const next = { ...before, ...patch, notes_exclude: splitKeepEntries(excludeText) };
    setKeep(next);
    void save('keep', { ...latest.current, keep: next }, () => setKeep(before));
  };

  const commitExclude = () => {
    typing.current = false;
    const entries = splitKeepEntries(excludeText);
    const before = latest.current.keep;
    if (JSON.stringify(entries) === JSON.stringify(before.notes_exclude ?? [])) return;
    const next = { ...before, notes_exclude: entries };
    setKeep(next);
    void save('keep', { ...latest.current, keep: next }, () => { setKeep(before); setExcludeText(excludeOf(before)); });
  };

  const onCopies = (patch: Partial<HostCopyChoice>) => {
    const before = latest.current.copies;
    const next = { ...before, ...patch };
    setCopies(next);
    void save('copies', { ...latest.current, copies: next }, () => setCopies(before));
  };

  return (
    <SettingsGroup
      heading="What the cloud companion keeps"
      footer="What it does not keep is answered by this Mac, and needs this Mac while it is away."
      data-testid="companion-keep"
    >
      <ReplicaKeepRows
        idOf={(field) => `companion-keep-${field}`}
        name="the cloud companion"
        keep={keep}
        excludeText={excludeText}
        onKeep={onKeep}
        onExcludeText={(text) => { typing.current = true; setExcludeText(text); }}
        onExcludeCommit={commitExclude}
      />
      {error?.at === 'keep' && <SettingsRow label="Not saved" indent error={error.message} data-testid="companion-keep-error" />}
      <div className="settings-disclosure-content host-server-copies" data-testid="companion-copies">
        <ReplicaCopyRows
          idOf={(key) => `companion-copy-${key}`}
          copies={copies}
          busy={busy}
          label="Also kept"
          help="What the companion still shows while this Mac sleeps."
          onChange={onCopies}
        />
        {error?.at === 'copies' && <SettingsRow label="Not saved" indent error={error.message} data-testid="companion-keep-error" />}
      </div>
    </SettingsGroup>
  );
}
