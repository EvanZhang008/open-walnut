/**
 * The user-PATH `walnut` shim a production daemon installs (daemon-standalone.ts
 * userWalnutShimText, installUserWalnutShim: ~/.local/bin/walnut), evaluated from the daemon's own
 * source (its TS annotation dropped), so a test runs the very text a host gets. A test host whose
 * daemon dir is not the production one never gets it installed (IS_PROD_DAEMON_DIR), and that shim
 * is what carries a session's `walnut` across a daemon restart (it waits on `<dir>/restarting`).
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const USER_WALNUT_SHIM_TAG = 'walnut-user-shim'

export function walnutUserShimText(prodDir = '/tmp/open-walnut'): string {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
  const fnStart = src.indexOf('function userWalnutShimText(): string {')
  if (fnStart < 0) throw new Error('daemon-standalone.ts has no userWalnutShimText()')
  const fnSrc = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2).replace('userWalnutShimText(): string {', 'userWalnutShimText() {')
  // The function references PROD_DAEMON_DIR, USER_WALNUT_SHIM_MARKER and USER_WALNUT_SHIM_TAG.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'PROD_DAEMON_DIR', 'USER_WALNUT_SHIM_MARKER', 'USER_WALNUT_SHIM_TAG',
    fnSrc + '\nreturn userWalnutShimText();',
  ) as (prodDir: string, marker: string, tag: string) => string
  return make(prodDir, `${USER_WALNUT_SHIM_TAG} v1`, USER_WALNUT_SHIM_TAG)
}
