/**
 * Which kinds the Mac copies to a replica (core/replication/kinds/copy-kind.ts): the
 * same rows and defaults for every replica (a host's "Walnut on a host" row, the cloud
 * companion in Phones & Cloud). A kind not kept is answered by this Mac.
 */
import { SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { HOST_COPY_ROWS, copyChoiceOf, copyChoicePatch, type HostCopyChoice } from './host-servers-status';

interface Props {
  /** A row's id and test id from its key (`host-server-copy-<host>-<key>`). */
  idOf: (key: keyof HostCopyChoice) => string;
  copies: Partial<HostCopyChoice> | undefined;
  busy?: boolean;
  onChange: (patch: Partial<HostCopyChoice>) => void;
  /** The heading row's sentence. */
  help: string;
  label?: string;
}

export function ReplicaCopyRows({ idOf, copies, busy, onChange, help, label = 'Kept on this host' }: Props) {
  const choice = copyChoiceOf(copies);
  return (
    <>
      <SettingsRow label={label} help={help} />
      {HOST_COPY_ROWS.map((row) => (
        <SettingsCheckbox
          key={row.key}
          id={idOf(row.key)}
          checked={choice[row.key]}
          disabled={busy || (row.with !== undefined && !choice[row.with])}
          label={row.label}
          data-testid={idOf(row.key)}
          onChange={(v) => onChange(copyChoicePatch(row.key, v))}
        />
      ))}
    </>
  );
}
