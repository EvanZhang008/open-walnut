/**
 * Asks which machine to open a path on when the words around it were written on several
 * (the Board's page and the Brief). While the machines are read it says so, and Cancel works.
 */
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import type { BoardHostChoice } from '@/components/board/board-model';

export type PathSourcePick = BoardHostChoice & { open: () => void };

export function PathSourceChooser({ path, hosts, onPick, onCancel, buttonTestId }: {
  path: string;
  /** null while the machines are read. */
  hosts: readonly PathSourcePick[] | null;
  /** Clears the caller's choice before the pick opens, without outdating the click that read the machines. */
  onPick: () => void;
  onCancel: () => void;
  buttonTestId?: string;
}) {
  const hostLabel = useHostDisplayLabels();
  return (
    <ConfirmDialog
      title="Choose the path's source"
      message={<>
        <p role="status">{hosts
          ? 'The same path was written on different machines. Choose the machine to open it on.'
          : 'The same path was written by different sources. Finding the machine each one is on…'}</p>
        <p className="board-file-source-path">{path}</p>
        {hosts && <div className="board-file-source-choices">{hosts.map((pick) => <button
          key={pick.host} type="button" className="app-modal-btn" data-testid={buttonTestId} onClick={() => {
            const { open } = pick;
            onPick();
            open();
          }}
        >{`${hostLabel(pick.host || '__local__')}: ${pick.details.join('; ')}`}</button>)}</div>}
      </>}
      confirmLabel="Cancel"
      onConfirm={onCancel}
      onCancel={onCancel}
    />
  );
}
