/**
 * A plugin script that outlives the host's daemon (src/core/hosts/host-script.ts runScriptOnHost,
 * 'host-script-detach-v1'): asked with a scriptId, asked again with the SAME id when the link went
 * while it ran (the daemon restarting), so the next daemon answers that run, never a second one; a
 * daemon without the capability (or the switch off) runs it as before; a host put back to an older
 * version while it ran says so.
 */
import { describe, expect, it, vi } from 'vitest'

const on = vi.hoisted(() => ({ value: true }))
vi.mock('../../../src/core/hosts/work-survives.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/hosts/work-survives.js')>()),
  workSurvives: async (conn: { hasCapability?: (n: string) => boolean }, cap: string) => on.value && conn.hasCapability?.(cap) === true,
}))

import { runScriptOnHost, type ScriptConn } from '../../../src/core/hosts/host-script.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'

const input = { script: 'echo hi', args: [], timeoutMs: 5_000, maxOutputBytes: 1024 }
const okReply = { ok: true, code: 0, stdout: 'hi\n', stderr: '', timedOut: false, truncated: false }

function link(caps: string[], replies: Array<() => Record<string, unknown>>, sent: Array<Record<string, unknown>>): ScriptConn {
  return {
    hasCapability: (n) => caps.includes(n),
    send: async (_cmd, params) => { sent.push(params ?? {}); const r = replies.shift(); if (!r) throw new Error('no reply'); return r() },
  }
}

describe('runScriptOnHost with a detached script', () => {
  it('asks again by the same scriptId after the link went, and returns the one run\'s result', async () => {
    const sent: Array<Record<string, unknown>> = []
    const caps = ['host-script-v1', 'host-script-detach-v1']
    const links = [
      link(caps, [() => { throw markLinkFailure(new Error('lost'), 'lost') }], sent),
      link(caps, [() => okReply], sent),
    ]
    let dials = 0
    const r = await runScriptOnHost('h', input, { reaskMs: 5, dial: async () => { dials++; if (dials === 2) throw new Error('not back'); return links.shift()! } })
    expect(r).toMatchObject({ code: 0, stdout: 'hi\n' })
    expect(sent).toHaveLength(2)
    expect(sent[0]!.scriptId).toMatch(/^hs-/)
    expect(sent[1]!.scriptId).toBe(sent[0]!.scriptId)
    expect(sent.every((p) => p.detach === true)).toBe(true)
  })

  it('a daemon without the capability, or the switch off: one ask without scriptId, as before', async () => {
    for (const [caps, flag] of [[['host-script-v1'], true], [['host-script-v1', 'host-script-detach-v1'], false]] as const) {
      on.value = flag
      const sent: Array<Record<string, unknown>> = []
      const r = await runScriptOnHost('h', input, { dial: async () => link([...caps], [() => okReply], sent) })
      expect(r.code).toBe(0)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.scriptId).toBeUndefined()
      expect(sent[0]!.detach).toBeUndefined()
    }
    on.value = true
  })

  it('the host came back as an older version (a rollback ended the script): a clear error, no second run', async () => {
    const sent: Array<Record<string, unknown>> = []
    const links = [
      link(['host-script-v1', 'host-script-detach-v1'], [() => { throw markLinkFailure(new Error('lost'), 'lost') }], sent),
      link(['host-script-v1'], [() => okReply], sent),
    ]
    const err = await runScriptOnHost('h', input, { reaskMs: 5, dial: async () => links.shift()! }).catch((e) => e)
    expect(String(err)).toContain('older version')
    expect(sent).toHaveLength(1)
  })

  it('the script\'s own refusal is the answer, never asked again', async () => {
    const sent: Array<Record<string, unknown>> = []
    const err = await runScriptOnHost('h', input, { reaskMs: 5, dial: async () => link(['host-script-v1', 'host-script-detach-v1'], [() => ({ ok: false, error: 'exec.script failed: bad args' })], sent) }).catch((e) => e)
    expect(String(err)).toContain('bad args')
    expect(sent).toHaveLength(1)
  })
})
