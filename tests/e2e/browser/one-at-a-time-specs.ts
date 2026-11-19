/**
 * Specs that change something the fixture server has only one of. Every spec file runs
 * against the same server, in parallel workers, so two specs of one group running at once
 * change that thing under each other. Each group runs in a project of its own with one
 * worker (playwright.config.ts), while every other spec stays parallel. A group is found by
 * what its specs call, so a new spec joins its group by itself.
 *
 * - The host fixture (POST /api/test/host-fixture): one spec loads its hosts while another's
 *   test reads them (2026-10-29: banner-placement-round4 N3-2 failed 2 of 3 runs beside
 *   system-attention :267).
 * - The sign-in state (sign-in-state.ts): the server's one tunnel (config.yaml's `expose`)
 *   and the browsers signed in with a code. A spec that turned the tunnel on again or off
 *   moved it to a new address under another spec's open phones, and "Sign out all browsers"
 *   signs out every browser on the server (2026-11-18: browser-access-tunnel's removed-phone
 *   test and phone-settings C75 failed together in the browser gate, ERR_CONNECTION_REFUSED
 *   through a tunnel the other file had restarted). A spec that serves its page's phone
 *   links reads that state: the page makes a new link whenever any browser signs in on the
 *   server (2026-11-19: browser-access-addresses counted a third link, made when
 *   browser-access-tunnel signed a phone in beside it).
 */
import fs from 'node:fs'
import path from 'node:path'

/** A spec that swaps the server's one host fixture. */
export const HOST_FIXTURE_CALL = /\b(?:loadFixture|hostFixture|resetServerHostFixture)\(/

/** A spec that drives the server's tunnel, signs a browser in, or serves its page's phone links (sign-in-state.ts). */
export const SIGN_IN_CALL = /\b(?:useServerTunnel|startServerTunnel|mintBrowserCode|serveBrowserCodes)\(/

/** `**\/<spec>` globs of the specs in `dir` whose source matches `call`. */
export function specsCalling(dir: string, call: RegExp): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts') && call.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map((f) => `**/${f}`)
}
