/**
 * A locked note whose key is not in Passwords (a new computer, a vault set up again): the key comes
 * back from its backup in Walnut's data folder (core/vault/locked-notes-key-backup.ts,
 * docs/reference/locked-notes.md "Backup of the key") with the master password and Secret Key of the
 * vault that made the backup. The backup that holds this note's key is picked first, and backups
 * whose keys are all in Passwords already are left out. Nothing typed here is kept: no draft, no
 * storage, cleared once used.
 */
import { useEffect, useState } from 'react';
import { lockedNotesApi, type KeyBackupVault } from '@/api/locked-notes';
import { VaultApiError } from '@/api/vault';
import { Radio } from '@/components/controls';
import { LockIcon } from '@/components/passwords/pw-icons';
import { unlockRefusalText } from '../../../../src/core/vault/unlock-retry';
import { operationErrorWords } from '@/utils/operation-error-words';
import { noteName } from './locked-note';
import '@/styles/passwords.css';

type Backups = { kind: 'loading' } | { kind: 'none'; words: string } | { kind: 'failed'; words: string } | { kind: 'ready'; list: KeyBackupVault[] };

const ELSEWHERE = 'Restore the item "Walnut locked notes key" from a Passwords backup or the Passwords trash, then press Show.';
const NO_BACKUP = `Walnut keeps a backup of this key in its data folder, and none is here. ${ELSEWHERE}`;
const ALL_IN = `The backups here hold only keys that are in Passwords already, and none of them opens this note. ${ELSEWHERE}`;

const backupLabel = (b: KeyBackupVault, i: number) => `${i === 0 ? 'Newest backup' : `Older backup ${i}`}${b.hint ? `, hint: ${b.hint}` : ''}`;
const wordsOf = (err: unknown) => operationErrorWords(err instanceof Error ? err.message : String(err));

/** `onRestored`: Show again, answering whether the key is still missing. `onBack`: back to the note's Show. */
export function LockedNoteKeyRestore({ notePath, onRestored, onBack }: { notePath: string; onRestored: () => Promise<string>; onBack: () => void }) {
  const [backups, setBackups] = useState<Backups>({ kind: 'loading' });
  const [pick, setPick] = useState(0);
  const [pw, setPw] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let gone = false;
    lockedNotesApi.keyBackups(notePath)
      .then((all) => {
        if (gone) return;
        const list = all.filter((b) => !b.inVault);
        if (!list.length) { setBackups({ kind: 'none', words: ALL_IN }); return; }
        setBackups({ kind: 'ready', list });
        setPick(Math.max(0, list.findIndex((b) => b.holdsNoteKey)));
      })
      .catch((err) => {
        if (gone) return;
        if (err instanceof VaultApiError && err.code === 'no_key_backup') setBackups({ kind: 'none', words: NO_BACKUP });
        else setBackups({ kind: 'failed', words: wordsOf(err) });
      });
    return () => { gone = true; };
  }, [notePath]);

  const from = backups.kind === 'ready' ? backups.list[pick] ?? backups.list[0] : undefined;

  const restore = async () => {
    if (!from || !pw || !secretKey.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { added } = await lockedNotesApi.restoreKey(from, pw, secretKey.trim());
      setPw('');
      setSecretKey('');
      // Shown: this card goes. Still shut: that backup did not hold this note's key.
      if ((await onRestored()) === 'key_missing') {
        setError(added
          ? 'That backup\'s key went back into Passwords, but it does not open this note. Pick another backup.'
          : 'That backup holds no key this note needs. Pick another backup, or restore the item from a Passwords backup.');
      }
    } catch (err) {
      setError(err instanceof VaultApiError
        ? (err.code === 'wrong_password' ? 'That master password and Secret Key do not open this backup.' : unlockRefusalText(err))
        : wordsOf(err));
      setPw('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pw-gate notes-locked-restore" data-testid="locked-note-key-restore">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void restore(); }}>
        <div className="pw-gate-icon pw-gate-icon-lock"><LockIcon size={28} /></div>
        <h1>Restore the key</h1>
        <p className="pw-gate-sub">
          The key that opens &ldquo;{noteName(notePath)}&rdquo; is not in Passwords on this computer.
          {backups.kind === 'ready' && ' Walnut kept a backup of it: enter the master password and Secret Key of the Passwords vault you locked it with.'}
        </p>
        {backups.kind === 'loading' && <p className="pw-hint" role="status">Looking for the backup…</p>}
        {backups.kind === 'none' && <p className="pw-hint" role="status" data-testid="locked-note-no-backup">{backups.words}</p>}
        {backups.kind === 'failed' && <p className="pw-hint pw-hint-bad" role="alert">{backups.words}</p>}
        {backups.kind === 'ready' && (
          <>
            {backups.list.length > 1 && (
              <div className="pw-radio-col notes-locked-restore-pick" role="group" aria-label="Which backup">
                {backups.list.map((b, i) => (
                  <Radio key={b.entry} name="locked-note-backup" checked={pick === i} disabled={busy}
                    onChange={() => { setPick(i); setError(''); }} label={backupLabel(b, i)} />
                ))}
              </div>
            )}
            <input data-no-draft="secret" className="pw-input pw-input-big" type="password" autoComplete="off" autoFocus
              placeholder="Master password" aria-label="Master password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy}
              data-testid="locked-note-restore-password" />
            {from?.hint && backups.list.length === 1 && <p className="pw-hint-shown"><span>Hint:</span> {from.hint}</p>}
            <label className="pw-field-label" htmlFor="locked-note-restore-sk">Secret Key (from that vault's recovery kit)</label>
            <input data-no-draft="secret" id="locked-note-restore-sk" className="pw-input pw-mono" autoComplete="off" spellCheck={false}
              placeholder="W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} disabled={busy}
              data-testid="locked-note-restore-secret-key" />
            {error && <div className="pw-hint pw-hint-bad" role="alert" data-testid="locked-note-restore-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-block pw-btn-block" disabled={!pw || !secretKey.trim() || busy} data-testid="locked-note-restore">
              {busy ? 'Restoring…' : 'Restore and show'}
            </button>
          </>
        )}
        {backups.kind !== 'loading' && (
          <button type="button" className="btn btn-block pw-btn-block" disabled={busy} onClick={onBack} data-testid="locked-note-restore-back">Back</button>
        )}
      </form>
    </div>
  );
}
