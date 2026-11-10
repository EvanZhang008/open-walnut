/**
 * Shows the Passwords unlock a plugin asked for (walnut.passwords.unlock) over everything open,
 * its plugin's dialog included. The sheet and the Passwords styles load only when one is asked.
 */
import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from 'react'
import { log } from '@/utils/log'
import { getPasswordsUnlock, settlePasswordsUnlock, subscribePasswordsUnlock } from './passwords-unlock-store'

const PasswordsUnlockSheet = lazy(() => import('@/components/passwords/PasswordsUnlockSheet'))

/** A sheet that fails to load or render answers false, so the plugin is not left waiting and the next ask can open. */
class UnlockBoundary extends Component<{ sequence: number; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) {
    log.error('passwords', 'the unlock sheet failed', { error: error instanceof Error ? error.message : String(error) })
    settlePasswordsUnlock(this.props.sequence, false)
  }
  render() { return this.state.failed ? null : this.props.children }
}

export function PasswordsUnlockHost() {
  const request = useSyncExternalStore(subscribePasswordsUnlock, getPasswordsUnlock, getPasswordsUnlock)
  return request ? <UnlockBoundary key={request.sequence} sequence={request.sequence}>
    <Suspense fallback={null}><PasswordsUnlockSheet request={request} /></Suspense>
  </UnlockBoundary> : null
}
