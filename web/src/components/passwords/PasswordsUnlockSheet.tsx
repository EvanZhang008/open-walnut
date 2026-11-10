/**
 * The unlock a plugin asked for, as a sheet over the page: Walnut's own unlock screen, saying which
 * plugin asks and why, with a Cancel. Walnut never gives the master password to the plugin, which
 * hears only whether this window is unlocked now.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { vaultSession } from '@/api/vault'
import '@/api/vault-live'
import { useModalOverlay } from '@/hooks/useModalOverlay'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'
import { getPasswordsUnlockOpener, settlePasswordsUnlock, type PasswordsUnlockRequest } from '@/plugins/passwords-unlock-store'
import { KitScreen, UnlockScreen, type KitToShow } from './LockScreens'
import '@/styles/passwords.css'

export default function PasswordsUnlockSheet({ request }: { request: PasswordsUnlockRequest }) {
  const ref = useRef<HTMLDivElement>(null)
  const [kit, setKit] = useState<KitToShow | null>(null)
  // An unlock or a recovery on its way: closing now would lose its answer (a new recovery kit).
  const busy = useRef(false)
  const onBusy = useCallback((value: boolean) => { busy.current = value }, [])
  const opener = useRef(getPasswordsUnlockOpener())
  const done = (ok: boolean) => settlePasswordsUnlock(request.sequence, ok)
  // Escape cancels, except while busy and while a recovery kit (the person's only copy) is on screen.
  useModalOverlay(() => { if (!kit && !busy.current) done(false) })
  // One layer of its own: Tab stays in the sheet, and no popover under it takes its keys or clicks.
  useOverlayLayer({ open: true, refs: [ref], closeOnOutside: false, closeOnEscape: false, trapFocus: true, onClose: () => {} })
  useLayoutEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })
    return () => {
      const before = opener.current
      queueMicrotask(() => { if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true }) })
    }
  }, [])
  const sub = `${request.pluginName} asks to unlock Passwords${request.reason ? ` ${request.reason}` : ''}. Enter your master password; Walnut does not give it to ${request.pluginName}.`
  return createPortal(
    <div className="pw-unlock-sheet-overlay" onPointerDown={(event) => event.stopPropagation()}>
      <div ref={ref} className="pw-unlock-sheet" role="dialog" aria-modal="true" aria-label="Unlock Passwords" tabIndex={-1} data-testid="pw-unlock-sheet">
        {kit ? <KitScreen {...kit} doneLabel="Done" onDone={() => done(!!vaultSession())} />
          : <UnlockScreen status={request.status} sub={sub} onBusy={onBusy} onCancel={() => done(false)} onKit={setKit} onUnlocked={() => done(!!vaultSession())} />}
      </div>
    </div>, document.body,
  )
}
