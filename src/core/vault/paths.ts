/**
 * Where the vault lives. The user's real Walnut keeps it outside the data home, in
 * `$XDG_STATE_HOME/open-walnut/vault` (default ~/.local/state), so git sync never
 * carries it, the same rule as the fleet secrets master. A throwaway server (a test
 * runner, an ephemeral server, a data home in a temp or task dir, a fake HOME) keeps
 * its own in `<data home>/vault`, so it never opens or writes the user's real one.
 * `WALNUT_VAULT_DIR` (absolute) wins over both.
 */
import os from 'node:os'
import path from 'node:path'

export async function vaultDir(): Promise<string> {
  const override = process.env.WALNUT_VAULT_DIR
  if (override && path.isAbsolute(override)) return path.resolve(override)
  const [{ semanticLaneDecision }, { IS_EPHEMERAL, WALNUT_HOME }] = await Promise.all([
    import('../search/semantic-default.js'), import('../../constants.js'),
  ])
  const real = semanticLaneDecision({ env: { ...process.env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on
  if (!real) return path.join(WALNUT_HOME, 'vault')
  const xdg = process.env.XDG_STATE_HOME
  const state = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state')
  return path.join(state, 'open-walnut', 'vault')
}
