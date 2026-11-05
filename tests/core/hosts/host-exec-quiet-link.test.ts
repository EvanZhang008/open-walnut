/**
 * dial (src/core/hosts/host-exec.ts): a link that has been quiet is asked whether it answers before
 * work goes on it, and a link that does not answer gets nothing. 2026-11-04: a pinned run sent 11 s
 * after the Mac woke from a 6-minute sleep went into a link that never answered again; the host
 * never made the job, and the caller could not tell whether it ran.
 *
 * The check's clock against a real link (a held loop, a slow round trip, the relay) is in
 * host-exec-dial-real.test.ts.
 *
 * MACHINE SAFETY: the link is a stand-in object; no socket, process or file. The run path's
 * caller, task, config, grant and job record are stand-ins too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-exec-quiet-link'))

type Verdict = 'heard' | 'alive' | 'dropped' | 'silent' | 'down'
const stand = vi.hoisted(() => ({ verdict: 'heard' as string, asked: [] as Array<Record<string, number>>, sent: [] as string[] }))
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: async () => ({
    hasCapability: () => true,
    send: async (cmd: string) => { stand.sent.push(cmd); return { ok: true, running: false, exitCode: 0, output: '' } },
    recheckQuiet: (o: Record<string, number>) => { stand.asked.push(o); return Promise.resolve(stand.verdict) },
  }),
}))
vi.mock('../../../src/core/hosts/host-display-name.js', () => ({ hostDisplayNameFor: (h: string) => h }))
// The run path's own steps before the dial, as stand-ins: a session caller on devbox with a grant on macbox.
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({ resolveCaller: async () => ({ kind: 'session', record: { taskId: 't-quiet', claudeSessionId: 's-quiet', host: 'devbox' } }) }))
vi.mock('../../../src/core/task-manager.js', () => ({ getTask: async () => ({ title: 'Quiet link' }) }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { macbox: {}, devbox: {} } }) }))
vi.mock('../../../src/core/hosts/joined-twins.js', () => ({ joinedAliasOf: () => () => null }))
vi.mock('../../../src/core/hosts/host-exec-prompts.js', () => ({ promptRefusal: async () => null }))
vi.mock('../../../src/core/hosts/host-exec-jobs.js', () => ({ startedRun: () => undefined, noteStarted: async () => {} }))
vi.mock('../../../src/core/hosts/host-exec-grant.js', () => ({
  GRANT_ID_RE: /^xg-[A-Za-z0-9-]{4,64}$/, grantFor: async () => 'xg-quiet', pinnedGrant: async () => 'xg-quiet', assertStillGranted: async () => 'xg-quiet', isOwnHost: async () => false,
}))

import { dial, execOnHost, HostExecError } from '../../../src/core/hosts/host-exec.js'

async function refusal(v: Verdict) {
  stand.verdict = v
  return dial('macbox').then(() => null, (e: unknown) => e as HostExecError)
}

beforeEach(() => { stand.asked = []; stand.sent = []; stand.verdict = 'heard' })

describe('a quiet link before work goes on it', () => {
  it('one heard from lately or that answers the check is used', async () => {
    expect(await refusal('heard')).toBeNull()
    expect(await refusal('alive')).toBeNull()
    // Asked once each, with a check that fits inside the dial's own budget, answered by then on the
    // probe's own clock (withinMs): no second timer here to call a held loop's link silent (review 3).
    expect(stand.asked).toHaveLength(2)
    expect(stand.asked[0]).toMatchObject({ quietMs: 20_000 })
    expect(stand.asked[0].deadlineMs).toBeLessThanOrEqual(3_000)
    expect(stand.asked[0].withinMs).toBe(stand.asked[0].deadlineMs)
  })

  it('this machine\'s own daemon is never asked: a loopback link survives a sleep (review 3)', async () => {
    stand.verdict = 'silent'
    for (const h of ['__local__', 'local']) expect(await dial(h).then(() => null, (e: unknown) => e)).toBeNull()
    expect(stand.asked).toEqual([])
  })

  it('a run whose dial is refused sends no exec.run; one whose link answers does (2026-11-05 review)', async () => {
    for (const v of ['silent', 'dropped', 'down'] as const) {
      stand.verdict = v
      const err = await execOnHost({ host: 'macbox', command: 'echo hi' }, 's-quiet').then(() => null, (e: unknown) => e as HostExecError)
      expect(err, v).toMatchObject({ status: 503, code: 'host_offline' })
    }
    expect(stand.sent).not.toContain('exec.run')
    stand.verdict = 'alive'
    await execOnHost({ host: 'macbox', command: 'echo hi' }, 's-quiet').catch(() => null)
    expect(stand.sent).toContain('exec.run')
  }, 30_000)

  it('one that does not answer is refused as offline, saying nothing was sent', async () => {
    for (const v of ['silent', 'dropped', 'down'] as const) {
      const err = await refusal(v)
      expect(err).toBeInstanceOf(HostExecError)
      expect(err).toMatchObject({ status: 503, code: 'host_offline', data: { quietLink: v } })
      // Of this call only: a retry of a job that already started must not read as "it never ran" (2026-11-05 review).
      expect(err!.message).toContain('this call sent nothing there (what an earlier call started there keeps running)')
      expect(err!.message.includes('Walnut is reconnecting to it')).toBe(v === 'dropped')
      // A link already down was checked by nobody: the refusal does not say it was.
      expect(err!.message.includes('did not answer a check')).toBe(v !== 'down')
    }
  })
})
