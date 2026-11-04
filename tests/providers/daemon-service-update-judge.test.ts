/**
 * What a managed daemon update's answer and its tail's record say (src/providers/daemon-service-update.ts
 * judgeServiceUpdate), and above all which failures are the new build's own: those the callers
 * back off a day (daemon-build-backoff.ts), the rest only the short cooldown.
 *
 * MACHINE SAFETY: pure; nothing runs.
 */
import { describe, expect, it } from 'vitest'
import { judgeServiceUpdate } from '../../src/providers/daemon-service-update.js'
import { LAUNCHD_NOT_SPAWNING } from '../../src/providers/daemon-service-launchd.js'

const answer = (failure: Record<string, unknown> | null) => JSON.stringify(failure ? { ok: false, failure } : { ok: true })
const thrown = (output: string, tail: Parameters<typeof judgeServiceUpdate>[1] = null) => {
  try { judgeServiceUpdate(output, tail); return null } catch (error) { return error as Error & { buildFailed?: boolean; tailOutcome?: string | null } }
}

describe('judgeServiceUpdate', () => {
  it('applied only when the update answered ok and the tail found its daemon serving', () => {
    expect(judgeServiceUpdate(answer(null), { outcome: 'serving', words: 'a daemon answers' })).toBe('applied')
    expect(judgeServiceUpdate(answer(null), null)).toBe('applied')
  })

  // 2026-11-04 review: the CLI's own check failed after the old daemon stopped (notReady,
  // verifyFailed) and it rolled back answering ok:false; that read like a refusal that changed
  // nothing, so the build was tried again every 10 min, each time stopping the healthy daemon.
  it.each(['notReady', 'verifyFailed'])('a %s after the old daemon stopped is the build\'s own failure', (code) => {
    expect(thrown(answer({ code, message: 'the daemon never answered as ready', stopped: true, rollback: 'restored' }))?.buildFailed).toBe(true)
  })

  // 2026-11-04 review 4: only notReady and verifyFailed were held, so a new config launchd would
  // not bootstrap, or a unit that would not start, was tried again every 10 min (SSH and this
  // machine), each try a stop and a rollback of the healthy daemon.
  it.each([
    ['commandFailed', 'Bootstrap failed: 5: Input/output error'],
    ['commandFailed', 'Job for open-walnut-daemon.service failed because the control process exited with error code'],
    ['invalidConfig', 'the written unit did not read back'],
    ['hostError', 'EIO: i/o error, write'],
  ])('any other failure after the stop (%s: %s) is held the same way', (code, message) => {
    expect(thrown(answer({ code, message, stopped: true, rollback: 'restored' }))?.buildFailed).toBe(true)
  })

  it('a failure before the stop, or launchd starting nothing, is not the build\'s', () => {
    expect(thrown(answer({ code: 'notReady', message: 'the daemon never answered as ready' }))?.buildFailed).toBe(false)
    expect(thrown(answer({ code: 'updateRefused', message: 'active ACP workers', stopped: false }))?.buildFailed).toBe(false)
    expect(thrown(answer({ code: 'commandFailed', message: 'bootstrap failed' }))?.buildFailed).toBe(false)
    expect(thrown(answer({ code: 'notReady', message: `launchd loaded x and started no process: ${LAUNCHD_NOT_SPAWNING}`, stopped: true }))?.buildFailed).toBe(false)
    expect(thrown(answer({ code: 'launchdNotSpawning', message: 'update deferred: launchd is starting no jobs in this login session now', stopped: true }))?.buildFailed).toBe(false)
  })

  it('answered ok and then put back or left with none is the build\'s; a stand-in (the new build outside launchd) is not', () => {
    expect(thrown(answer(null), { outcome: 'restored', words: 'put back' })?.buildFailed).toBe(true)
    expect(thrown(answer(null), { outcome: 'down', words: 'no daemon' })).toMatchObject({ buildFailed: true, tailOutcome: 'down' })
    expect(thrown(answer(null), { outcome: 'standin', words: 'outside launchd' })?.buildFailed).toBe(false)
  })
})

// 2026-11-04 review 5: every failed update logged "the running daemon keeps serving", also one
// whose answer never came back and one whose tail found no daemon at all.
describe('a build whose probation failed on the host', () => {
  // 2026-11-04 review 5: a build that died after its tail's verdict was run again on the next try.
  // The runner refuses it before anything is touched (daemon-net-update-io.ts), and that answer
  // holds it the same day, though nothing was stopped.
  it('is the build\'s own failure, held the day, and stopped nothing', () => {
    const e = thrown(answer({ code: 'probationFailed', stopped: false, message: 'this build did not stay serving on the host after an update lately (its probation), so the update was not run again' }))
    expect(e).toMatchObject({ buildFailed: true, stopped: false })
  })
})

describe('afterUpdateFailure', () => {
  it('says what the failure left on the host, case by case', async () => {
    const { afterUpdateFailure } = await import('../../src/providers/daemon-update-readback.js')
    const { NetUpdateUnansweredError } = await import('../../src/providers/daemon-net-update-io.js')
    const { DaemonUpdateStageError } = await import('../../src/providers/daemon-service-update.js')
    expect(afterUpdateFailure(new NetUpdateUnansweredError('no answer', '/tmp/open-walnut-update.Ab12'))).toMatch(/did not come back over the link/)
    expect(afterUpdateFailure(new DaemonUpdateStageError('upload failed'))).toBe('nothing changed on the host, and the running daemon keeps serving')
    expect(afterUpdateFailure(thrown(answer(null), { outcome: 'down', words: 'no daemon' }))).toBe('no daemon serves on the host now')
    expect(afterUpdateFailure(thrown(answer(null), { outcome: 'restored', words: 'put back' }))).toBe('the daemon from before the update serves again')
    expect(afterUpdateFailure(thrown(answer(null), { outcome: 'standin', words: 'outside' }))).toMatch(/outside launchd/)
    expect(afterUpdateFailure(thrown(answer({ code: 'updateRefused', message: 'busy', stopped: false }), { outcome: 'serving', words: 'a daemon answers' }))).toBe('the update stopped nothing, and the running daemon keeps serving')
    expect(afterUpdateFailure(thrown(answer({ code: 'notReady', message: 'never ready', stopped: true }), { outcome: 'serving', words: 'a daemon answers' }))).toBe('a daemon serves on the host')
    expect(afterUpdateFailure(thrown('garbage', null))).toBe('what serves on the host now is not known')
  })
})
