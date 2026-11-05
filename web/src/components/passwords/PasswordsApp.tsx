/**
 * The Passwords app (left rail): setup the first time, the lock screen, then the vault.
 * Its state follows the browser's vault session (shared by every tab): Lock, auto-lock or a 401
 * anywhere drops the opened items and shows the lock screen again.
 */
import { useCallback, useEffect, useState } from 'react'
import { onVaultSessionChange, vaultApi, VaultApiError, type VaultStatus } from '@/api/vault'
import { KitScreen, SetupFlow, UnlockScreen, type KitToShow } from './LockScreens'
import { VaultBrowser } from './VaultBrowser'
import '@/styles/passwords.css'

export function PasswordsApp() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [error, setError] = useState('')
  // Once setup starts it owns the screen until the person confirms the recovery kit:
  // the unlock it makes would otherwise switch to the vault before the Secret Key shows.
  const [settingUp, setSettingUp] = useState(false)
  // A recovery kit (after setup or a recovery) stays up until confirmed, whatever the unlock changes.
  const [kit, setKit] = useState<KitToShow | null>(null)
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
  // A Lock elsewhere (the extension, another browser) shows here without a reload: a quiet check
  // (no use of the vault) when the page comes back into view, and every minute while it is seen.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      void vaultApi.status({ quiet: true }).then((st) => {
        // A dead unlock was dropped by status() (the listener refreshes).
        setStatus((cur) => (cur && cur.unlocked === st.unlocked && cur.setUp === st.setUp ? cur : st))
      }).catch(() => {})
    }
    const t = window.setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', check) }
  }, [])

  // The failed request already dropped the unlock it went with (api/vault.ts call()), never a newer one.
  const locked = useCallback(() => { void refresh() }, [refresh])

  if (error) return <div className="pw-gate"><div className="pw-gate-card"><h1>Passwords</h1><p className="pw-hint pw-hint-bad" role="alert">{error}</p></div></div>
  if (kit) return <KitScreen {...kit} onDone={() => { setKit(null); setSettingUp(false); void refresh() }} />
  if (!status) return <div className="pw-gate" aria-busy="true" />
  if (!status.setUp || settingUp) return <SetupFlow onKit={setKit} />
  if (!status.unlocked) return <UnlockScreen status={status} onUnlocked={() => void refresh()} onKit={setKit} />
  return <VaultBrowser status={status} onLocked={locked} />
}
