/**
 * A session's call counts as the session's own only from the host it runs on, and one box can be
 * two host aliases of one daemon (2026-11-16: a session Walnut started on clouddev called in over
 * newdev's link to the same daemon, lost its task, and its browser tab showed in no Browser view).
 * So every check of a session's recorded host against a call's origin goes through ONE function,
 * fromHost (src/core/hosts/session-host-origin.ts), which knows the aliases of one daemon. This
 * fails when a new comparison of a host origin appears anywhere else in src/.
 *
 * The same holds for the bare host alias a daemon relayed a call over (2026-11-19: a trigger check
 * armed on clouddev called in over newdev's link and was refused trigger_wrong_host): every module
 * that holds a relayed call's host (an exported holdRelay*) compares it only through oneHost.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../src')

/** Comparisons that are not a session's host against a call's origin, each with why. */
const ALLOWED: Record<string, string> = {
  // The function itself.
  'core/hosts/session-host-origin.ts:fromHost': 'the one check',
  // The pure table of where a check may run; its only caller (assertCheckHostAllowed) asks fromHost before refusing.
  'core/routines/check-host-policy.ts:checkHostRefusal': 'pure table, overridden by fromHost in assertCheckHostAllowed',
  // A relay's proof names the link it came over, which is the call's origin by construction.
  'web/routes/approvals-v1.ts:held.host': 'relay proof: the relay link, not the session host',
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('session host against call origin: one check', () => {
  it('every comparison of a hostOrigin(...) with another value is fromHost or listed', () => {
    const found: string[] = []
    for (const f of files(ROOT)) {
      const rel = path.relative(ROOT, f)
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/hostOrigin\([^)]*\)\s*[!=]==|[!=]==\s*hostOrigin\(/.test(line)) return
        const key = /held\.host/.test(line) ? `${rel}:held.host`
          : rel === 'core/hosts/session-host-origin.ts' ? `${rel}:fromHost`
            : rel === 'core/routines/check-host-policy.ts' && /hostOrigin\(host\) === origin/.test(line) ? `${rel}:checkHostRefusal` : `${rel}:${i + 1}`
        if (!ALLOWED[key]) found.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(found, 'compare a host with a call\'s origin through fromHost (src/core/hosts/session-host-origin.ts)').toEqual([])
  })

  it('the session identity check and the check-host gate use fromHost', () => {
    expect(fs.readFileSync(path.join(ROOT, 'web/routes/approvals-v1.ts'), 'utf8')).toMatch(/caller\.kind === 'session' && await \(await import\('\.\.\/\.\.\/core\/hosts\/session-host-origin\.js'\)\)\.fromHost\(caller\.record\.host, origin\)/)
    expect(fs.readFileSync(path.join(ROOT, 'core/routines/check-host-policy.ts'), 'utf8')).toMatch(/refusal && !\(await fromHost\(/)
  })

  it('a module that holds the host a call was relayed over compares it only through oneHost', () => {
    const holders = files(ROOT).filter((f) => /export function holdRelay\w*\(/.test(fs.readFileSync(f, 'utf8')))
    expect(holders.map((f) => path.relative(ROOT, f)).sort()).toEqual(expect.arrayContaining(['core/approvals/relay-proof.ts', 'core/hosts/trigger-caller.ts']))
    const found: string[] = []
    for (const f of holders) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const bare = line.replace(/typeof [\w.]+\s*[!=]==\s*'\w+'/g, '')
        if (/\b\w+\.host\b\s*[!=]==|[!=]==\s*\w+\.host\b/.test(bare)) found.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(found, 'compare a relayed call\'s host through oneHost (src/core/hosts/session-host-origin.ts)').toEqual([])
    expect(fs.readFileSync(path.join(ROOT, 'core/hosts/trigger-caller.ts'), 'utf8').match(/await oneHost\(h\.host, /g)).toHaveLength(2)
  })
})
