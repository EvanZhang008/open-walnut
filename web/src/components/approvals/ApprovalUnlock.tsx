/**
 * "Unlock to approve": a guarded approval (an agent's buy, send or delete in the browser; a vault
 * ask) that this window cannot approve while Passwords is locked here. The card offers the unlock
 * in place: the master password (and the Secret Key when this device needs it), and once this
 * window is unlocked the store draws Approve (approvals-store.ts follows the vault session), so
 * the person never leaves the card or opens Passwords first. An unlock made elsewhere on this
 * computer (the extension, another window) is shared with no password while the form is open.
 */
import { useEffect, useRef, useState } from 'react';
import { vaultApi, VaultApiError } from '@/api/vault';
import { checkVault } from '@/api/vault-live';
import { unlockRefusalText } from '../../../../src/core/vault/unlock-retry';

export function ApprovalUnlock({ onCancel }: { onCancel: () => void }) {
  const [pw, setPw] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [needKey, setNeedKey] = useState(false);
  const [busy, setBusy] = useState(false);
  // Another unlock is being checked: this one waits its turn (vaultApi.unlock sends it again).
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // The Secret Key field shows only when Walnut asks for it (`secret_key_needed`): most unlocks need the password alone.
  useEffect(() => { input.current?.focus(); }, []);
  // Passwords unlocked elsewhere on this computer (the extension, another window): this window
  // shares it with no password (`vault:changed`, api/vault-live.ts), and the store then draws
  // Approve. Behind the event, in case its socket is down, a look every few seconds.
  useEffect(() => {
    const look = () => { if (document.visibilityState === 'visible') void checkVault(); };
    look();
    const t = window.setInterval(look, 3_000);
    return () => window.clearInterval(t);
  }, []);
  const unlock = async () => {
    if (!pw || busy) return;
    setBusy(true); setError('');
    try {
      await vaultApi.unlock(pw, undefined, needKey ? secretKey : undefined, { onWait: () => setChecking(true) });
      setPw(''); setSecretKey('');
    } catch (err) {
      if (err instanceof VaultApiError && err.code === 'secret_key_needed') setNeedKey(true);
      setError(err instanceof VaultApiError ? unlockRefusalText(err) : err instanceof Error ? err.message : String(err));
      setPw('');
      input.current?.focus();
    } finally {
      setBusy(false);
      setChecking(false);
    }
  };
  return (
    <form className="approval-unlock" data-testid="approval-unlock" onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
      <label className="approval-unlock-label" htmlFor="approval-unlock-pw">Unlock Passwords in this window to approve</label>
      <input id="approval-unlock-pw" ref={input} data-no-draft="secret" className="approval-unlock-input" type="password" autoComplete="current-password"
        placeholder="Master password" aria-label="Master password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {needKey && (
        <input data-no-draft="secret" className="approval-unlock-input" autoComplete="off" spellCheck={false} aria-label="Secret Key"
          placeholder="Secret Key (W1-…)" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
      )}
      {error ? <div className="approval-error" role="alert">{error}</div> : null}
      <div className="approval-actions">
        <button type="button" className="approval-btn approval-btn-deny" onClick={onCancel}>Cancel</button>
        <button type="submit" className="approval-btn approval-btn-approve" disabled={!pw || busy || (needKey && !secretKey)}>
          {busy ? (checking ? 'Checking…' : 'Unlocking…') : 'Unlock'}
        </button>
      </div>
    </form>
  );
}
