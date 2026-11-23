/**
 * Every liveness closer of DaemonConnection asks the one "still sending" rule before it closes a
 * link or counts a miss toward closing it. 2026-11-23: the read probe kept clouddev up while an
 * upload went out, and the quiet check (host_exec's) closed it 2 s later, because only the read
 * probe asked; a read probe also closed clouddev while olddev's 34 MB update filled the one
 * walnut-net both ride. A new closer that does not ask fails here.
 *
 * The closers are found in the source: every `this.dropSilentLink(` call and every miss count
 * (`_missedPongs += 1`). Each must sit after a `busySending(` call in the same method, or (the
 * upstream check, which watches the Mac's own sending) after its UPSTREAM_BUSY_BYTES rule.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-connection.ts'), 'utf8')
const CLOSER = /this\.dropSilentLink\(|_missedPongs \+= 1/g
const RULE = /busySending\(|UPSTREAM_BUSY_BYTES/

/** The text from the start of the method (a class-member line at two spaces) that holds `at`. */
function methodBefore(at: number): string {
  const head = SRC.slice(0, at)
  const lines = head.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ {2}(private |protected |public |static |async |get |set )*[A-Za-z_]\w*\s*[(<]/.test(lines[i])) return lines.slice(i).join('\n')
  }
  return head
}

describe('the one busy rule for every liveness closer', () => {
  const sites = [...SRC.matchAll(CLOSER)].map((m) => m.index ?? 0)

  it('finds the closers (the probe, the ping loop, the upstream check)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4)
  })

  it('every closer, except the close of the link itself, asks the rule first in its method', () => {
    const missing: string[] = []
    for (const at of sites) {
      const method = methodBefore(at)
      // dropSilentLink's own body and its definition line are not callers.
      if (/^ {2}private dropSilentLink\(/.test(method)) continue
      if (!RULE.test(method)) {
        const line = SRC.slice(0, at).split('\n').length
        missing.push(`daemon-connection.ts:${line}: ${method.split('\n')[0].trim()}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('the read probe, the quiet check and the ping loop share busySending, not a rule of their own', () => {
    expect(SRC).toMatch(/const sending = this\.busySending\(kind\)/)
    expect(SRC).toMatch(/this\.busySending\('ping'\)/)
    // The old read-only exemption is gone.
    expect(SRC).not.toMatch(/kind === 'read' && this\.sentOnLinkWithin/)
  })
})
