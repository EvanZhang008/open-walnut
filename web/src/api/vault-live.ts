/**
 * Every Walnut window follows the vault as it changes anywhere (docs/reference/passwords.md, "One
 * unlock on this computer"). The server announces each change of who holds an unlock as
 * `vault:changed` (src/core/vault/sessions.ts, envelope only); this window then reads its own
 * status quietly (vaultApi.status): an unlock that ended with a Lock elsewhere (the extension,
 * another window) is dropped, and a locked window that may share an unlock made on this computer
 * takes it. Either way vault.ts tells its session listeners (onVaultSessionChange), so every
 * surface that reads the vault (the Passwords page, Settings → Passwords, the approval cards)
 * follows within the event's round trip, with no reload and no poll. A reconnect looks once too,
 * for a change made while the socket was down.
 *
 * Every web file that reads the vault state imports this module (tests/web/vault-live-guard.test.ts),
 * so the following never depends on which surface happens to be mounted.
 */
import { wsClient } from './ws'
import { onVaultSessionChange, vaultApi, vaultSession, type VaultStatus } from './vault'

/** The longest one status read keeps a caller waiting: then it answers null (nothing known). */
export const READ_TIMEOUT_MS = 6_000

/** The read running now, shared by every caller that asked before it started. */
let inFlight: Promise<VaultStatus | null> | null = null
/** One more read after it, shared by every caller that asked while it ran. */
let queued: Promise<VaultStatus | null> | null = null

/**
 * The token this page saw Walnut give it (an unlock, a share, another tab's unlock) or a status read
 * confirm. A token that was only in storage when the page opened proves nothing: the unlock it was
 * may have ended while no page of this browser was open (a restart under "Until restart", a Lock
 * elsewhere), and no `vault:changed` comes for that (review 2026-11-06).
 */
let confirmed: string | null = null

function readOnce(): Promise<VaultStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = vaultApi.status({ quiet: true }).then((st) => {
    // status() dropped a dead token and joined a shareable unlock: what is stored now is live.
    if (st.unlocked) confirmed = vaultSession()
    return st
  })
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS) })
  // A slow read answers null after READ_TIMEOUT_MS; if it lands later it still drops or joins (the
  // session listeners hear it), it only stops keeping its callers waiting.
  const p: Promise<VaultStatus | null> = Promise.race([read, late])
    .catch(() => null) // the server is away or answered an error: the next event or reconnect looks again
    .finally(() => { clearTimeout(timer); if (inFlight === p) inFlight = null })
  inFlight = p
  return p
}

/**
 * Read this window's vault status now (quiet: no use of the vault), joining an unlock made on this
 * computer when the server says it may. A call while a read runs gets one more read that starts
 * after it, shared by every call made meanwhile, so the answer is never older than the call, and
 * every caller is answered within two reads, each at most READ_TIMEOUT_MS: a page polling every few
 * seconds can never keep another caller waiting (review 2026-11-06: one trailing loop did).
 */
export function checkVault(): Promise<VaultStatus | null> {
  if (!inFlight) return readOnce()
  if (!queued) {
    queued = inFlight.then(() => {
      queued = null
      return inFlight ?? readOnce()
    })
  }
  return queued
}

/**
 * This window holds an unlock Walnut gave it or confirmed while this page runs (never a token that
 * was only left in storage): what an Approve needs before it is offered.
 */
export function vaultLive(): boolean {
  const t = vaultSession()
  return !!t && t === confirmed
}

const onChanged = () => { void checkVault() }

if (typeof window !== 'undefined') {
  wsClient.onEvent('vault:changed', onChanged)
  wsClient.onEvent('_ws:reconnected', onChanged)
  // The Walnut extension in this browser, unlocked, just put this browser's key into localStorage
  // (packages/browser-extension/src/page-browser-key.ts): read again now, so a locked window shares
  // the extension's unlock with no master password. Anything else posting this only causes a read.
  window.addEventListener('message', (e) => {
    const d = e.data as { source?: unknown; type?: unknown } | null
    if (e.source === window && e.origin === window.location.origin && d?.source === 'walnut-extension' && d.type === 'vault-browser-key') onChanged()
  })
  // A token set while this page runs came from Walnut just now (setup, an unlock, a share, another tab's).
  onVaultSessionChange(() => { const t = vaultSession(); if (t) confirmed = t })
}

/** Tests: start from nothing. */
export function resetVaultLiveForTest(): void {
  inFlight = null
  queued = null
  confirmed = null
}
