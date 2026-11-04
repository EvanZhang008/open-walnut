/**
 * Remote Hosts > More settings > Session limits: how many sessions one host runs at once
 * (config.session_limits, keyed by the hosts' aliases plus "local"). Each limit is a row,
 * host on the left, its number on the right (N3-21), and the last row adds one, the same
 * shape as Search > Excluded folders.
 */
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { SettingsButton } from '../inputs/SettingsButton';

export function SessionLimitsGroup({ limits, onChange }: {
  limits: Record<string, string | number>;
  onChange: (update: (prev: Record<string, string | number>) => Record<string, string | number>) => void;
}) {
  return (
    <SettingsGroup heading="Session limits" footer="Most sessions one host runs at once." data-testid="rh-session-limits">
      {Object.entries(limits).map(([alias, max]) => (
        <SettingsRow
          key={alias}
          className="rh-limit-row"
          data-limit-host={alias}
          label={alias === 'local' ? 'This Mac' : <span className="settings-addons-mono">{alias}</span>}
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
                aria-label={`Remove the limit for ${alias}`}
                onClick={() => onChange((prev) => { const next = { ...prev }; delete next[alias]; return next; })}
              >
                Remove
              </SettingsButton>
            </>
          }
        />
      ))}
      <AddLimitRow taken={Object.keys(limits)} onAdd={(alias, max) => onChange((prev) => ({ ...prev, [alias]: max }))} />
    </SettingsGroup>
  );
}

export function AddLimitRow({ taken, onAdd }: { taken: string[]; onAdd: (alias: string, max: number) => void }) {
  // A limit typed and not added yet survives leaving the pane; Add ends it.
  const form = useDraftValue<{ alias: string; max?: number }>(draftKey('host-limit', 'new'), { alias: '' });
  const { alias, max } = form.value;
  const setAlias = (next: string) => form.setValue((f) => ({ ...f, alias: next }));
  const setMax = (next: number | undefined) => form.setValue((f) => ({ ...f, max: next }));
  const name = alias.trim();
  const clash = name !== '' && taken.includes(name);
  const ready = name !== '' && !clash && max !== undefined;
  const add = () => {
    if (!ready) return;
    onAdd(name, max);
    form.clear();
  };
  return (
    <SettingsRow
      className="rh-limit-add"
      label="Add limit"
      htmlFor="rh-limit-new-host"
      help={clash ? 'That host already has a limit above.' : 'A host alias, or local for this Mac.'}
      state={clash ? 'warning' : undefined}
      control={
        <>
          <input
            id="rh-limit-new-host"
            type="text"
            data-draft-key={form.key ?? undefined}
            className="settings-input settings-input--short settings-input--mono"
            value={alias}
            placeholder="local"
            aria-label="Host alias"
            spellCheck={false}
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <NumberInput id="rh-limit-new-max" data-draft-key={form.key ?? undefined} value={max} onChange={setMax} onEnter={add} min={0} placeholder="4" aria-label="Most sessions" />
          <SettingsButton onClick={add} disabled={!ready} title={ready ? undefined : 'Type a host and a number first.'}>Add</SettingsButton>
        </>
      }
    />
  );
}
