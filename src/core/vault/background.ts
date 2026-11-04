/**
 * The vault's own background work on the primary (server.ts starts it): at start, when the
 * person keeps Passwords unlocked "until restart" or "forever", Walnut unlocks itself from this
 * Mac's keychain (keychain-unlock.ts) so a restart does not leave agents locked out; and the
 * daily Bitwarden sync timer (bitwarden-run.ts). Nothing here runs on a throwaway server (an
 * ephemeral one, a test runner, a vault kept in the data home), which never has the real vault.
 */
import path from 'node:path'

async function realVault(): Promise<boolean> {
  if (process.env.VITEST || process.env.WALNUT_VAULT_BACKGROUND === '0') return false
  const [{ vaultDir }, { IS_EPHEMERAL, WALNUT_HOME }] = await Promise.all([import('./paths.js'), import('../../constants.js')])
  if (IS_EPHEMERAL) return false
  return (await vaultDir()) !== path.join(WALNUT_HOME, 'vault') || !!process.env.WALNUT_VAULT_DIR
}

/** Unlock at start from the keychain when the choice asks for it. Never throws; returns what happened. */
export async function unlockAtStart(): Promise<'unlocked' | 'open' | 'skipped' | string> {
  try {
    const st = await import('./store.js')
    const status = await st.vaultStatus()
    if (!status.setUp) return 'skipped'
    if (st.isOpen() && !status.agentsWhileAway) return 'open'
    const [{ getConfig }, { unlockChoice, unlocksAtStart }, kc] = await Promise.all([
      import('../config-manager.js'), import('./unlock-length.js'), import('./keychain-unlock.js'),
    ])
    const choice = unlockChoice((await getConfig()).passwords, status.agentsWhileAway)
    if (!unlocksAtStart(choice.unlockFor) || !kc.keychainAvailable()) return 'skipped'
    // Forever: the machine key already reopens the vault; a keychain unlock adds nothing.
    if (st.isOpen()) return 'open'
    if (!(await kc.keychainItemPresent())) return 'skipped'
    const r = await kc.unlockFromKeychain({ client: 'This Mac (keychain, at start)' })
    return r.ok ? 'unlocked' : r.code
  } catch (err) {
    return (err as Error).message
  }
}

export function startVaultBackground(): { stop: () => void } {
  let daily: { stop: () => void } | null = null
  let stopped = false
  void (async () => {
    if (!(await realVault()) || stopped) return
    const { log } = await import('../../logging/index.js')
    const r = await unlockAtStart()
    if (r === 'unlocked') log.web.info('passwords unlocked from this Mac\'s keychain at start')
    else if (r !== 'skipped' && r !== 'open') log.web.warn('passwords keychain unlock at start did not unlock', { outcome: r })
    if (stopped) return
    const { startDailyBitwardenSync } = await import('./bitwarden-run.js')
    daily = startDailyBitwardenSync()
  })().catch(() => undefined)
  return { stop: () => { stopped = true; daily?.stop() } }
}
