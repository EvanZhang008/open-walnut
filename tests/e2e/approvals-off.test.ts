/**
 * The one Approvals switch on a real server (src/core/approvals/ask-me.ts; 2026-11-12, the user:
 * "I want it to be off by default don't need my approval for anything"):
 *
 *  - off (nothing stored): Walnut's own asks go ahead, recorded as not asked; an explicit
 *    `walnut approve` still asks the person and waits (2026-11-12, the user: an approval they put
 *    in a script is the point of the feature), with no "stop asking me" on its card;
 *  - a session cannot turn it on or off (403 human_only); the person can, from any screen;
 *  - on: the same ask waits for the person again;
 *  - a single-use ask is never answered by the switch;
 *  - the person turns it off from any device they are signed in on (a paired phone too), with no
 *    extra approval (2026-11-21); an agent's call, from its session or as an automation, never does,
 *    nor a config.yaml written to off by another path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-approvals-off-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { runApprove } from '../../src/core/approvals/cli-core.js'
import { opFailure } from '../../src/commands/approve.js'
import { createApproval } from '../../src/core/approvals/store.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { asksPerson } from '../../src/core/approvals/ask-me.js'

let base = ''
const before = process.env.WALNUT_APPROVALS_ASK

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

async function waitPending(what: string): Promise<Record<string, any>> {
  for (let i = 0; i < 100; i++) {
    const list = (await http('GET', '/api/v1/approvals')).body.approvals as Array<Record<string, any>>
    const found = list.find((a) => a.what === what)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no pending approval "${what}"`)
}

function approve(what: string, timeoutMs = 10_000) {
  const said: string[] = []
  const code = runApprove({ what, timeoutMs, json: true, cwd: '/work/repo', command: 'post.sh' }, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (l) => said.push(l),
    out: () => {},
  })
  return { code, said }
}

beforeAll(async () => {
  // The product's default: nothing stored and no test-setup default.
  delete process.env.WALNUT_APPROVALS_ASK
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  if (before === undefined) delete process.env.WALNUT_APPROVALS_ASK
  else process.env.WALNUT_APPROVALS_ASK = before
})

describe('approvals are off by default', () => {
  it('a built-in ask goes ahead, but an explicit walnut approve still waits for the person', async () => {
    expect(await asksPerson()).toBe(false)
    const run = approve('Post the release notes to the team channel?', 30_000)
    const rec = await waitPending('Post the release notes to the team channel?')
    expect(rec).toMatchObject({ status: 'pending', outsideSwitch: true })
    expect(rec.unasked).toBeUndefined()
    expect((await http('POST', `/api/v1/approvals/${rec.id}/answer`, { decision: 'approve' })).status).toBe(200)
    expect(await run.code, run.said.join('\n')).toBe(0)
  })

  it('never answers a single-use ask', async () => {
    await expect(createApproval({
      what: 'Push one commit?', singleUse: true, unasked: 'approve',
      requester: { host: 'local' },
    } as Parameters<typeof createApproval>[0])).rejects.toThrow()
  })
})

describe('only the person moves the switch', () => {
  it('refuses a session and lets the person turn it on, then the ask waits again', async () => {
    const bySession = await http('PUT', '/api/config', { approvals: { ask_me: true } }, { 'x-walnut-caller-sid': 'sess-agent' })
    expect(bySession.status).toBe(403)
    expect(bySession.body.code).toBe('human_only')
    expect((await http('PUT', '/api/config', { approvals: { ask_me: 'yes' } })).status).toBe(400)

    const byPerson = await http('PUT', '/api/config', { approvals: { ask_me: true } })
    expect(byPerson.status).toBe(200)
    // Saving it back unchanged is fine for anyone.
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } }, { 'x-walnut-caller-sid': 'sess-agent' })).status).toBe(200)

    const run = approve('Delete the old preview site?')
    expect(await run.code, run.said.join('\n')).toBe(2)

    const off = await http('PUT', '/api/config', { approvals: { ask_me: false } }, { 'x-walnut-caller-sid': 'sess-agent' })
    expect(off.status).toBe(403)
    expect((await http('PUT', '/api/config', { approvals: { ask_me: false } })).status).toBe(200)
    expect(await asksPerson()).toBe(false)
  })
})

describe('the person turns it off from any device they are signed in on; nothing else does', () => {
  it('a paired phone turns it off at once; an agent and another write path never do', async () => {
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } })).status).toBe(200)
    // Other write paths: config.yaml written to off through updateConfig stays on.
    await updateConfig({ approvals: { ask_me: false } })
    expect(await asksPerson()).toBe(true)
    const shown = await http('GET', '/api/config')
    expect(shown.body.approvals?.ask_me ?? shown.body.config?.approvals?.ask_me).toBe(true)
    expect((await http('GET', '/api/v1/approvals')).body.askMe).toBe(true)
    // An agent: refused, from its session or as an automation.
    for (const h of [{ 'x-walnut-caller-sid': 'sess-agent' }, { 'x-walnut-caller-kind': 'agent' }]) {
      const r = await http('PUT', '/api/config', { approvals: { ask_me: false } }, h)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('human_only')
    }
    expect(await asksPerson()).toBe(true)
    // The person's phone: off, with no approval of its own and no signature.
    const paired = await http('POST', '/api/devices', { name: 'approvals-off-e2e-phone' })
    const off = await http('PUT', '/api/config', { approvals: { ask_me: false } }, { authorization: `Bearer ${paired.body.token}` })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(await asksPerson()).toBe(false)
    const latch = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'approvals', 'switch.json'), 'utf8'))
    expect(latch).toMatchObject({ on: false, by: { person: true } })
    // Nothing waits as a turn-off, and an older phone app reads an empty list of signing devices.
    const list = await http('GET', '/api/v1/approvals')
    expect(list.body.keys).toEqual([])
    expect((list.body.approvals as Array<Record<string, unknown>>).filter((a) => a.turnsAskMeOff)).toEqual([])
  }, 60_000)
})
