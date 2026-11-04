/**
 * Remote Hosts > More settings > Session limits: how many sessions one host runs at once
 * (config.session_limits, keyed by the hosts' aliases plus "local"). Each limit is a row, the
 * host by its name on the left, its number on the right (N3-21), and the last row adds one:
 * a host picked from the list (2026-11-04 review: a typed alias, and rows that said "devbox"
 * where the rest of the page says "Alpha box").
 */
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { SettingsRow } from '../SettingsSection';
import { SettingsFoldGroup } from '../SettingsFoldGroup';
import { NumberInput } from '../inputs/NumberInput';
import { SettingsButton } from '../inputs/SettingsButton';

const LOCAL = 'local';

export function SessionLimitsGroup({ limits, hostLabels, onChange }: {
  limits: Record<string, string | number>;
  /** Each saved host's alias and its name. */
  hostLabels: Record<string, string>;
  onChange: (update: (prev: Record<string, string | number>) => Record<string, string | number>) => void;
}) {
  const name = (alias: string) => (alias === LOCAL ? 'This Mac' : hostLabels[alias] || alias);
  const entries = Object.entries(limits);
  const summary = entries.length
    ? entries.map(([alias, max]) => `${name(alias)}: ${max}`).join(', ')
    : 'No limit: each host runs what it is given';
  return (
    <SettingsFoldGroup id="rh-more-session-limits" heading="Session limits" summary={summary} footer="Most sessions one host runs at once." data-testid="rh-session-limits">
      {entries.map(([alias, max]) => (
        <SettingsRow
          key={alias}
          className="rh-limit-row"
          data-limit-host={alias}
          label={name(alias)}
          help={alias !== LOCAL && name(alias) !== alias ? <span className="settings-addons-mono">{alias}</span> : undefined}
          htmlFor={`rh-limit-${alias}`}
          control={
            <>
              <NumberInput
                id={`rh-limit-${alias}`}
                value={typeof max === 'number' ? max : parseInt(String(max), 10) || undefined}
                onChange={(v) => onChange((prev) => ({ ...prev, [alias]: v ?? 0 }))}
                min={0}
                unit="sessions"
              />
              <SettingsButton
                variant="text"
                aria-label={`Remove the limit for ${name(alias)}`}
                onClick={() => onChange((prev) => { const next = { ...prev }; delete next[alias]; return next; })}
              >
                Remove
              </SettingsButton>
            </>
          }
        />
      ))}
      <AddLimitRow
        hosts={[LOCAL, ...Object.keys(hostLabels)].filter((a) => !Object.hasOwn(limits, a)).map((alias) => ({ alias, name: name(alias) }))}
        onAdd={(alias, max) => onChange((prev) => ({ ...prev, [alias]: max }))}
      />
    </SettingsFoldGroup>
  );
}

export function AddLimitRow({ hosts, onAdd }: { hosts: { alias: string; name: string }[]; onAdd: (alias: string, max: number) => void }) {
  // A limit picked and not added yet survives leaving the pane; Add ends it.
  const form = useDraftValue<{ alias: string; max?: number }>(draftKey('host-limit', 'new'), { alias: '' });
  const { max } = form.value;
  // A host picked before that got its limit (or went away) is no pick any more.
  const alias = hosts.some((h) => h.alias === form.value.alias) ? form.value.alias : '';
  const setAlias = (next: string) => form.setValue((f) => ({ ...f, alias: next }));
  const setMax = (next: number | undefined) => form.setValue((f) => ({ ...f, max: next }));
  const ready = alias !== '' && max !== undefined;
  const add = () => {
    if (!ready) return;
    onAdd(alias, max);
    form.clear();
  };
  if (hosts.length === 0) return <SettingsRow className="rh-limit-add" label="Add limit" help="Every host has a limit." />;
  return (
    <SettingsRow
      className="rh-limit-add"
      label="Add limit"
      htmlFor="rh-limit-new-host"
      help="Pick a host and the most sessions it runs at once."
      control={
        <>
          <select
            id="rh-limit-new-host"
            data-testid="rh-limit-new-host"
            className="settings-select"
            data-draft-key={form.key ?? undefined}
            value={alias}
            aria-label="Host"
            onChange={(e) => setAlias(e.target.value)}
          >
            <option value="" disabled>Host</option>
            {hosts.map((h) => <option key={h.alias} value={h.alias}>{h.name}</option>)}
          </select>
          <NumberInput id="rh-limit-new-max" data-draft-key={form.key ?? undefined} value={max} onChange={setMax} onEnter={add} min={0} placeholder="4" aria-label="Most sessions" />
          <SettingsButton onClick={add} disabled={!ready} title={ready ? undefined : 'Pick a host and a number first.'}>Add</SettingsButton>
        </>
      }
    />
  );
}
