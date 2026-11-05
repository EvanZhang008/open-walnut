/**
 * Settings → Passwords → Master password hint: change it (the master password again, so the
 * hint is checked against it) or remove it. Shown on every unlock screen (HintField.tsx).
 */
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { vaultApi, VaultApiError, type VaultStatus } from '@/api/vault'
import { HINT_MAX } from '../../../../src/core/vault/hint'
import { HINT_HELP, hintError } from './HintField'

export function HintSettings({ status, onChanged }: { status: VaultStatus; onChanged: () => void }) {
  const unlocked = status.unlocked
  const [hint, setHint] = useState(status.hint ?? '')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'remove'>('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // Another window changed it: show the new one unless the person is editing.
  useEffect(() => { if (!pw) setHint(status.hint ?? '') }, [status.hint]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = hintError(hint, pw)
  const changed = hint.trim() !== (status.hint ?? '')
  const save = async (next: string, which: 'save' | 'remove') => {
    setBusy(which); setError(''); setNote('')
    try {
      await vaultApi.setHint(next, pw, status.kdf)
      setPw(''); setHint(next)
      setNote(next ? 'Hint saved. It shows on the unlock screen.' : 'Hint removed.')
      onChanged()
    } catch (err) {
      setError(err instanceof VaultApiError || err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <SettingsGroup heading="Master password hint" data-testid="pw-hint-settings"
      footer={<>{HINT_HELP} The hint is kept unencrypted beside the vault, so it shows while Passwords is locked.</>}>
      <SettingsRow label="Hint" htmlFor="pw-hint-edit"
        help={!unlocked ? 'Unlock Passwords in this window to change this.' : status.hint ? `Now: ${status.hint}` : 'No hint yet.'}
        error={problem || error || undefined}
        control={<input id="pw-hint-edit" data-no-draft="secret" autoComplete="off" spellCheck={false} maxLength={HINT_MAX} className="settings-input settings-input--short"
          disabled={!unlocked} value={hint} onChange={(e) => { setHint(e.target.value); setNote('') }} />} />
      <SettingsRow label="Master password" htmlFor="pw-hint-pw" help="Needed to save a new hint, so Walnut can check it does not give the password away."
        control={<input id="pw-hint-pw" type="password" data-no-draft="secret" autoComplete="current-password" className="settings-input settings-input--short"
          disabled={!unlocked} value={pw} onChange={(e) => setPw(e.target.value)} />} />
      <SettingsRow label="" help={note || undefined}
        control={<span style={{ display: 'inline-flex', gap: 8 }}>
          {status.hint && <SettingsButton busy={busy === 'remove'} disabled={!unlocked || !!busy} onClick={() => void save('', 'remove')} data-testid="pw-hint-remove">Remove hint</SettingsButton>}
          <SettingsButton busy={busy === 'save'} disabled={!unlocked || !!busy || !changed || !hint.trim() || !pw || !!problem}
            onClick={() => void save(hint.trim(), 'save')} data-testid="pw-hint-save">Save hint</SettingsButton>
        </span>} />
    </SettingsGroup>
  )
}
