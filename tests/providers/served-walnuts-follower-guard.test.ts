/**
 * Class guard: a server a daemon runs for a leader is that leader's Walnut in the record of the
 * Walnuts the daemon serves (served-walnuts-core.ts), on every path that records one.
 *
 * 2026-11-23: a host's replica pushed `turns.configure` naming its own data dir from its
 * own-sessions link; the daemon filed that dir as a second Walnut, and the leader kept an old
 * daemon for four hours because "another Walnut uses it". The fix maps a home to the Walnut it
 * is inside the core (`keyFor`, through `walnutOf`), so every note goes through it. This guard
 * fails when:
 *   - the core keys a home anywhere but `keyFor` and the stale-key prune (a new method that
 *     skips the mapping);
 *   - the daemon builds the record without `walnutOf` and `followerHomes` wired to the
 *     host server supervisor, or builds a second record;
 *   - a NEW `servedWalnuts.note(...)` call site appears in the daemon. A new site is fine once
 *     reviewed: it goes through `keyFor` by construction; add it to NOTE_SITES with the
 *     function it sits in.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const CORE = read('src/providers/served-walnuts-core.ts')
// The whole runtime: daemon-standalone.ts and its area modules (servedWalnutOf is daemon-spawn-journal.ts).
const DAEMON = daemonRuntimeText()

/** Every `servedWalnuts.note(` call in the daemon, by the top-level function it sits in. */
// The per-Walnut pushes of a server socket (SERVED_PUSHES, in the gates every command passes), and a socket bound to a home.
const NOTE_SITES = ['passCommandGates', 'bindGatewayClientHome']

function noteSites(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let fn = '(module)'
  for (const line of lines) {
    const m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (m) fn = m[1]!
    if (/\bservedWalnuts\.note\(/.test(line)) out.push(fn)
  }
  return out
}

describe('served walnuts: a server a daemon runs for a leader is never another Walnut', () => {
  it('the core keys a home only through keyFor (and the prune of an older build\'s key)', () => {
    const keyOfCalls = CORE.match(/deps\.keyOf\(/g) ?? []
    expect(keyOfCalls.length, 'deps.keyOf is called only in keyFor and prune').toBe(2)
    const body = CORE.slice(CORE.indexOf('export function createServedWalnuts'))
    expect(body).toMatch(/function keyFor\(home: string\): string \{[\s\S]*?deps\.keyOf\(walnutOf\(h\) \?\? h\)/)
    // note and knows key a home through keyFor.
    expect(body).toMatch(/note\(home\) \{\s*const key = keyFor\(home\)/)
    expect(body).toMatch(/knows\(home\) \{[\s\S]*?seen\[keyFor\(home\)\]/)
    // The file and the hello never carry a key the prune would drop.
    expect(body).toMatch(/function write\(\): void \{\s*prune\(\)/)
    expect(body).toMatch(/recent\(windowMs = KEEP_MS\) \{[\s\S]*?if \(prune\(\)\) write\(\)/)
  })

  it('the daemon keeps one record, with the follower mapping wired to the host server supervisor', () => {
    const made = DAEMON.match(/createServedWalnuts\(\{/g) ?? []
    expect(made.length, 'exactly one served-walnuts record').toBe(1)
    const start = DAEMON.search(/createServedWalnuts\(\{/)
    const deps = DAEMON.slice(start, DAEMON.indexOf('\n})', start))
    expect(deps).toMatch(/walnutOf: \(home\) => servedWalnutOf\(home\)/)
    expect(deps).toMatch(/followerHomes: \(\) => serverDataHomes\(\)/)
    // servedWalnutOf asks the supervisor's walnutOf; serverDataHomes its data dirs.
    expect(DAEMON).toMatch(/function servedWalnutOf\(home[^)]*\)[^{]*\{[\s\S]{0,200}hostServers\.walnutOf\(home\)/)
    expect(DAEMON).toMatch(/function serverDataHomes\(\)[^{]*\{[\s\S]{0,300}hostServers\.dataDirs\(\)/)
    // After the supervisor read its specs, the record is written again (an older build's key goes):
    // the next statement after boot() is that write, whatever comment lines sit between them.
    expect(DAEMON).toMatch(/hostServers\.boot\(\)[^\n]*\n(?:[ \t]*(?:\/\/[^\n]*)?\n)*[ \t]*servedWalnuts\.write\(\)/)
  })

  it('every servedWalnuts.note call site in the daemon is a known one', () => {
    expect(noteSites(DAEMON), 'a new servedWalnuts.note call: check it, then list it in NOTE_SITES').toEqual(NOTE_SITES)
  })
})
