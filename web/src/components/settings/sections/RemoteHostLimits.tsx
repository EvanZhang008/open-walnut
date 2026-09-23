/**
 * The last row of Remote Hosts > Session limits: a labelled row that adds a
 * limit, the same shape as Search > Excluded folders (N3-21). The limits
 * themselves are rows above it.
 */
import { useState } from 'react';
import { SettingsRow } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { SettingsButton } from '../inputs/SettingsButton';

export function AddLimitRow({ taken, onAdd }: { taken: string[]; onAdd: (alias: string, max: number) => void }) {
  const [alias, setAlias] = useState('');
  const [max, setMax] = useState<number | undefined>(undefined);
  const name = alias.trim();
  const clash = name !== '' && taken.includes(name);
  const ready = name !== '' && !clash && max !== undefined;
  const add = () => {
    if (!ready) return;
    onAdd(name, max);
    setAlias('');
    setMax(undefined);
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
            className="settings-input settings-input--short settings-input--mono"
            value={alias}
            placeholder="local"
            aria-label="Host alias"
            spellCheck={false}
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <NumberInput id="rh-limit-new-max" value={max} onChange={setMax} onEnter={add} min={0} placeholder="4" aria-label="Most sessions" />
          <SettingsButton onClick={add} disabled={!ready} title={ready ? undefined : 'Type a host and a number first.'}>Add</SettingsButton>
        </>
      }
    />
  );
}
