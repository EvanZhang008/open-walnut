/**
 * How a remote apply is started (src/core/standby/remote-apply.ts), against a stub link: the
 * daemon's exec.run gets what host_exec gives it (src/core/hosts/host-exec.ts: endGroup with the
 * group capability, detach only with both it and the detach one, a caller), and a start a daemon
 * cannot run says why in words.
 */
import { describe, expect, it } from 'vitest'
import { runApplyJob, type ApplyJobLink } from '../../../src/core/standby/remote-apply.js'
import { linkFailureKind, markLinkFailure } from '../../../src/providers/link-failure.js'

function stub(caps: string[], o: { survives?: boolean; start?: (params: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const starts: Array<Record<string, unknown>> = []
  const link: ApplyJobLink = {
    async call(cmd, params) {
      expect(cmd).toBe('exec.run')
      starts.push(params)
      return o.start ? o.start(params) : { ok: true }
    },
    readText: async () => JSON.stringify({ state: 'done', at: new Date().toISOString(), answer: { ok: 1 } }),
    probe: async () => ({ status: null, running: false }),
    hasCapability: (name) => caps.includes(name),
    // As work-survives.ts: the host says it can detach, and this server's experiment is on.
    detach: async () => o.survives === true && caps.includes('host-exec-detach-v1'),
  }
  return { link, starts }
}

const job = { jobId: 'hx-standby-test', argv: ['walnut', 'standby', 'receive', 'apply', '/t'], statusFile: '/t/.incoming/s.json', pollMs: 1 }

describe('starting a remote apply', () => {
  it.each([
    ['an old daemon (no group, no detach)', [], true, {}],
    ['group only', ['host-exec-group-v1'], true, { endGroup: true }],
    ['detach said but no group: no detach, as host_exec', ['host-exec-detach-v1'], true, {}],
    ['group and detach, work survives', ['host-exec-group-v1', 'host-exec-detach-v1'], true, { endGroup: true, detach: true }],
    ['group, work does not survive', ['host-exec-group-v1'], false, { endGroup: true }],
  ])('%s', async (_name, caps, survives, extra) => {
    const { link, starts } = stub(caps, { survives })
    expect(await runApplyJob(link, job)).toEqual({ ok: 1 })
    expect(starts).toHaveLength(1)
    const { jobId, argv, background, timeoutMs, caller, ...rest } = starts[0]
    expect({ jobId, argv, background, timeoutMs, caller }).toEqual({ jobId: job.jobId, argv: job.argv, background: true, timeoutMs: 2 * 60 * 60_000, caller: { task: 'standby-copy' } })
    // No taskId: the host would make a task folder for it.
    expect(rest).toEqual(extra)
  })

  it('a start the daemon refuses: one that cannot run commands says to update Walnut there; one that can gives its own error', async () => {
    const refuse = () => { throw Object.assign(new Error('unknown command exec.run'), { code: 'unknown_command' }) }
    const old = stub([], { start: refuse })
    const err = await runApplyJob(old.link, job).catch((e: unknown) => e as Error & { code?: string })
    expect(err.message).toMatch(/^the standby host could not start the apply: unknown command exec\.run \(its Walnut daemon does not say it runs background commands, host-exec-v1: update Walnut on that host\)$/)
    expect(err.code).toBe('unknown_command')

    const current = stub(['host-exec-v1'], { start: refuse })
    await expect(runApplyJob(current.link, job)).rejects.toThrow(/^the standby host could not start the apply: unknown command exec\.run$/)
  })

  it('a start lost with its link stays a link failure, with no word about versions', async () => {
    const { link } = stub([], { start: () => { throw markLinkFailure(new Error('link down'), 'no-link') } })
    const err = await runApplyJob(link, job).catch((e: unknown) => e)
    expect(linkFailureKind(err)).toBe('no-link')
    expect((err as Error).message).toBe('the standby host could not start the apply: link down')
  })

  it('a start sent again after its answer was lost (job_exists) follows the run it started', async () => {
    const { link, starts } = stub(['host-exec-v1'], { start: () => { throw Object.assign(new Error('exists'), { code: 'job_exists' }) } })
    expect(await runApplyJob(link, job)).toEqual({ ok: 1 })
    expect(starts).toHaveLength(1)
  })
})
