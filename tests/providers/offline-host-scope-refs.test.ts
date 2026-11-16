/**
 * The host daemon delivers a same-host task_send itself (offline-host-core.ts handleLocal), so a
 * send the server's scope check must judge (core/sessions/send-scope.ts) has to be left to the
 * server. The daemon's test is inlined (its factory references nothing at module scope); this
 * keeps it a superset of the server's patterns: every sample the server reads a ref in, the
 * daemon leaves to the server, and a plain message stays the daemon's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractScopeRefs } from '../../src/core/sessions/send-scope.js'
import { NOT_REF_SAMPLES, REF_SAMPLES } from '../helpers/scope-ref-samples.js'

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/providers/offline-host-core.ts'), 'utf8')

/** The two regex literals of the daemon's scope test, read from its source. */
function daemonPatterns(): RegExp[] {
  const at = SOURCE.indexOf('const said = ')
  expect(at, 'offline-host-core.ts handleLocal keeps its inline scope test').toBeGreaterThan(0)
  const body = SOURCE.slice(at, SOURCE.indexOf('return null', at))
  const literals = [...body.matchAll(/(\/(?:\\\/|[^/\n])+\/[gimsuy]*)\.test\(said\)/g)].map((m) => m[1])
  expect(literals).toHaveLength(2)
  return literals.map((lit) => new Function(`return ${lit}`)() as RegExp)
}

const leftToServer = (text: string) => daemonPatterns().some((re) => re.test(text))

describe('the daemon leaves every send the scope check judges to the server', () => {
  it('every line the server reads a ref in', () => {
    for (const line of REF_SAMPLES) {
      expect(extractScopeRefs(line).length, line).toBeGreaterThan(0)
      expect(leftToServer(line), line).toBe(true)
    }
  })

  it('each ref on its own', () => {
    for (const ref of extractScopeRefs(REF_SAMPLES.join('\n'))) {
      const alone = ref.kind === 'task_files' ? `see /x/tasks/${ref.ref}/a.md` : ref.kind === 'ticket' && /^\d+$/.test(ref.ref) ? `ticket ${ref.ref}` : ref.ref
      expect(leftToServer(alone), alone).toBe(true)
    }
  })

  it('a plain message stays the daemon\'s to deliver (a look-alike such as SHA-256 may go to the server: only slower)', () => {
    expect(leftToServer('How is the rollout going? Reply when you can.')).toBe(false)
    expect(leftToServer('Answer rq-10efc3c6771f by 2026-11-16; commit 3346a76a3 is on main, port 3456.')).toBe(false)
    expect(leftToServer(NOT_REF_SAMPLES[1])).toBe(false)
  })
})
