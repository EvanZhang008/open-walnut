/**
 * The Passwords app (left rail): setup the first time, the lock screen, then the vault.
 * Its state follows this window's vault session: Lock, auto-lock or a 401 anywhere
 * drops the opened items and shows the lock screen again.
 */
import { useCallback, useEffect, useState } from 'react'
import { onVaultSessionChange, vaultApi, VaultApiError, type VaultStatus } from '@/api/vault'
import { SetupFlow, UnlockScreen } from './LockScreens'
import { VaultBrowser } from './VaultBrowser'
import '@/styles/passwords.css'

export function PasswordsApp() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [error, setError] = useState('')
  // Once setup starts it owns the screen until the person confirms the recovery kit:
  // the unlock it makes would otherwise switch to the vault before the Secret Key shows.
  const [settingUp, setSettingUp] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setStatus(await vaultApi.status())
      setError('')
    } catch (err) {
      setError(err instanceof VaultApiError ? err.message : err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (status && !status.setUp) setSettingUp(true) }, [status])
  useEffect(() => onVaultSessionChange(() => { void refresh() }), [refresh])

  const locked = useCallback(() => { vaultApi.forget(); void refresh() }, [refresh])

  if (error) return <div className="pw-gate"><div className="pw-gate-card"><h1>Passwords</h1><p className="pw-hint pw-hint-bad" role="alert">{error}</p></div></div>
  if (!status) return <div className="pw-gate" aria-busy="true" />
  if (!status.setUp || settingUp) return <SetupFlow onDone={() => { setSettingUp(false); void refresh() }} />
  if (!status.unlocked) return <UnlockScreen status={status} onUnlocked={() => void refresh()} />
  return <VaultBrowser status={status} onLocked={locked} />
}
