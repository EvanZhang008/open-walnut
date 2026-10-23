/**
 * Which kinds the Mac copies to a replica (core/replication/kinds/copy-kind.ts): the
 * same rows and defaults for every replica (a host's "Walnut on a host" row, the cloud
 * companion in Phones & Cloud). A kind not kept is answered by this Mac. Each row is a
 * switch, like every other keep row (ReplicaKeepRows): a click answers at once, and a
 * second one while a save is on its way wins (`busy` only marks it).
 */
import { SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
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
        <SettingsRow
          key={row.key}
          label={row.label}
          htmlFor={idOf(row.key)}
          indent
          data-testid={`${idOf(row.key)}-row`}
          control={
            <ToggleSwitch
              id={idOf(row.key)}
              checked={choice[row.key]}
              // A row that rides with another (the messages with the chat list) is off with it.
              disabled={row.with !== undefined && !choice[row.with]}
              busy={busy}
              data-testid={idOf(row.key)}
              onChange={(v) => onChange(copyChoicePatch(row.key, v))}
            />
          }
        />
      ))}
    </>
  );
}
