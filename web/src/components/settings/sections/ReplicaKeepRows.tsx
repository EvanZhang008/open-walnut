/**
 * What a replica keeps a read copy of (core/host-replica.ts): the notes, their pictures
 * and files, the folders or single notes left out, the memory and the skills. The same
 * rows and defaults for every replica (a host in Remote Hosts, the cloud companion in
 * Phones & Cloud). What a replica does not keep is answered by this Mac.
 */
import type { Config } from '@open-walnut/core';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';

export type ReplicaKeep = NonNullable<NonNullable<Config['hosts']>[string]['keep']>;

/** One entry per comma: a folder of the vault, or one note (with or without `.md`). */
export function splitKeepEntries(text: string): string[] {
  return text.split(',').map((f) => f.trim()).filter(Boolean);
}

/** Only what differs from "keep everything" is written, so a saved replica round-trips unchanged. */
export function normalizeKeep(keep: ReplicaKeep | undefined): ReplicaKeep | undefined {
  if (!keep) return undefined;
  const exclude = (keep.notes_exclude ?? []).map((f) => f.trim()).filter(Boolean);
  const out: ReplicaKeep = {
    ...(keep.notes === false ? { notes: false } : {}),
    ...(exclude.length > 0 ? { notes_exclude: exclude } : {}),
    ...(keep.memory === false ? { memory: false } : {}),
    ...(keep.skills === false ? { skills: false } : {}),
    ...(keep.attachments === false ? { attachments: false } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

interface Props {
  /** A control's id from its field (`notes`, `exclude`): `rh-keep-notes-0`, `companion-keep-notes`. */
  idOf: (field: 'notes' | 'attachments' | 'exclude' | 'memory' | 'skills') => string;
  /** The replica's name, for the switches' labels. */
  name: string;
  keep: ReplicaKeep;
  /** The leave-out box as typed (a trailing comma survives). */
  excludeText: string;
  onKeep: (patch: Partial<ReplicaKeep>) => void;
  onExcludeText: (text: string) => void;
  /** The leave-out box lost focus or took Enter (a replica that saves on commit). */
  onExcludeCommit?: () => void;
  /** The always-kept row's sentence, when the replica has work of its own. */
  ownWork?: string;
  disabled?: boolean;
}

export function ReplicaKeepRows({ idOf, name, keep, excludeText, onKeep, onExcludeText, onExcludeCommit, ownWork, disabled }: Props) {
  return (
    <>
      {ownWork && (
        <SettingsRow label="Its own work" help={ownWork} indent control={<SettingsTag>Always kept</SettingsTag>} />
      )}
      <SettingsRow
        label="Notes"
        htmlFor={idOf('notes')}
        help="A copy of the notes, so its sessions and pages read them while this Mac is away."
        indent
        control={<ToggleSwitch id={idOf('notes')} checked={keep.notes !== false} disabled={disabled} onChange={(v) => onKeep({ notes: v })} aria-label={`Keep notes on ${name}`} />}
      />
      {keep.notes !== false && (
        <SettingsRow
          label="Pictures and files"
          htmlFor={idOf('attachments')}
          help="The pictures and files the notes embed."
          indent
          control={<ToggleSwitch id={idOf('attachments')} checked={keep.attachments !== false} disabled={disabled} onChange={(v) => onKeep({ attachments: v })} aria-label={`Keep attachments on ${name}`} />}
        />
      )}
      {keep.notes !== false && (
        <SettingsRow
          label="Leave out folders or notes"
          htmlFor={idOf('exclude')}
          help="Folders or single notes that stay only on this Mac, separated by commas."
          indent
          wide
          control={
            <input
              id={idOf('exclude')}
              type="text"
              className="settings-input settings-input--long"
              value={excludeText}
              disabled={disabled}
              onChange={(e) => onExcludeText(e.target.value)}
              onBlur={() => onExcludeCommit?.()}
              onKeyDown={(e) => { if (e.key === 'Enter' && onExcludeCommit) { e.preventDefault(); onExcludeCommit(); } }}
              placeholder="health, finance/taxes.md"
              spellCheck={false}
              data-testid={idOf('exclude')}
            />
          }
        />
      )}
      <SettingsRow
        label="Memory"
        htmlFor={idOf('memory')}
        help="MEMORY.md, USER.md and the rest of the memory folder."
        indent
        control={<ToggleSwitch id={idOf('memory')} checked={keep.memory !== false} disabled={disabled} onChange={(v) => onKeep({ memory: v })} aria-label={`Keep memory on ${name}`} />}
      />
      <SettingsRow
        label="Skills"
        htmlFor={idOf('skills')}
        help="The skills, with their reference files."
        indent
        control={<ToggleSwitch id={idOf('skills')} checked={keep.skills !== false} disabled={disabled} onChange={(v) => onKeep({ skills: v })} aria-label={`Keep skills on ${name}`} />}
      />
    </>
  );
}
