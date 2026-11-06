/**
 * The Passwords app (left rail): setup the first time, the lock screen, then the vault.
 * Its state follows the browser's vault session (shared by every tab): Lock, auto-lock or a 401
 * anywhere drops the opened items and shows the lock screen again. A Lock or an unlock elsewhere on
 * this computer (the extension, another window) reaches it through `vault:changed` (api/vault-live.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import { onVaultSessionChange, vaultApi, VaultApiError, vaultSession, type VaultStatus } from '@/api/vault'
import { checkVault } from '@/api/vault-live'
import { KitScreen, SetupFlow, UnlockScreen, type KitToShow } from './LockScreens'
import { VaultBrowser } from './VaultBrowser'
import '@/styles/passwords.css'

/**
 * How often a locked Passwords page looks for an unlock made elsewhere on this computer, besides
 * the `vault:changed` event (api/vault-live.ts), in case the event socket is down.
 */
const LOCKED_CHECK_MS = 3_000

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
  useEffect(() => onVaultSessionChange(() => {
    // This window holds no unlock any more (a Lock anywhere, an auto-lock, a 401): its items go
    // now, before the status read answers.
    if (!vaultSession()) setStatus((cur) => (cur?.unlocked ? { ...cur, unlocked: false } : cur))
    void refresh()
  }), [refresh])
  // A Lock or an unlock elsewhere arrives as `vault:changed` (api/vault-live.ts). Behind it, in case
  // the socket is down: a quiet check (no use of the vault) when the page comes back into view, every
  // minute while it is seen, and every few seconds while locked (status() shares an unlock made on
  // this computer when the server says canJoin).
  const lockedNow = !!status && status.setUp && !status.unlocked
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      void checkVault().then((st) => {
        // A dead unlock was dropped by status() (the listener refreshes).
        if (st) setStatus((cur) => (cur && cur.unlocked === st.unlocked && cur.setUp === st.setUp ? cur : st))
      })
    }
    const t = window.setInterval(check, lockedNow ? LOCKED_CHECK_MS : 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', check) }
  }, [lockedNow])

  // The failed request already dropped the unlock it went with (api/vault.ts call()), never a newer one.
  const locked = useCallback(() => { void refresh() }, [refresh])

  if (error) return <div className="pw-gate"><div className="pw-gate-card"><h1>Passwords</h1><p className="pw-hint pw-hint-bad" role="alert">{error}</p></div></div>
  if (kit) return <KitScreen {...kit} onDone={() => { setKit(null); setSettingUp(false); void refresh() }} />
  if (!status) return <div className="pw-gate" aria-busy="true" />
  if (!status.setUp || settingUp) return <SetupFlow onKit={setKit} />
  if (!status.unlocked) return <UnlockScreen status={status} onUnlocked={() => void refresh()} onKit={setKit} />
  return <VaultBrowser status={status} onLocked={locked} />
}
