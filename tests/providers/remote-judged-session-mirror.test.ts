/**
 * A host-run session's proxy (src/providers/remote-judged-session.ts) answers its mirrored getters
 * before its host reported anything: a session just handed over (an ACP read hands one over, then
 * answers with the proxy). A caller reads those getters as a session of its own (an array's `.some`,
 * a catalog's `availableModels`), so none may answer undefined unless it is listed here with why
 * (2026-11-23: `sessionControls.some` threw on a mode change right after a hand-over).
 */
import { describe, expect, it } from 'vitest'
import { RemoteJudgedSession, remoteJudgedSession, _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'

/** Getters that may answer undefined, each a value that is truly absent and read as optional by its callers. */
const MAY_BE_ABSENT: Record<string, string> = {
  taskId: 'a row with no task',
  activity: 'an ACP turn state not reported yet: callers compare it to a string',
  engineId: 'an ACP engine not reported yet: callers fall back to the row\'s engine',
  turnStartedAt: 'no turn running',
  teardownReason: 'not torn down',
  lastResultOrigin: 'no result yet',
  cachedAppliedSettings: 'no settings applied yet: callers treat it as none',
  promptCache: 'no prompt cache facts yet',
}

function getters(): string[] {
  return Object.entries(Object.getOwnPropertyDescriptors(RemoteJudgedSession.prototype))
    .filter(([, d]) => typeof d.get === 'function').map(([k]) => k).sort()
}

describe('a proxy with nothing reported yet', () => {
  it.each(['acp', 'native'] as const)('%s: every mirrored getter answers a value, or is listed as one that may be absent', (kind) => {
    _resetRemoteJudgedSessionsForTesting()
    const p = remoteJudgedSession(`sid-mirror-${kind}`, 'devbox-a', kind)
    const absent = getters().filter((g) => (p as unknown as Record<string, unknown>)[g] === undefined)
    expect(absent.filter((g) => !(g in MAY_BE_ABSENT))).toEqual([])
  })

  it('an ACP session\'s controls and model catalog read empty, never undefined', () => {
    _resetRemoteJudgedSessionsForTesting()
    const p = remoteJudgedSession('sid-mirror-empty', 'devbox-a', 'acp')
    expect(p.sessionControls).toEqual([])
    expect(p.modelCatalog).toEqual({ availableModels: [] })
    expect(p.controlsReported).toBe(false)
    expect(p.sessionControls.some(() => true)).toBe(false)
  })

  it('every name listed as possibly absent is still a getter of the proxy', () => {
    expect(Object.keys(MAY_BE_ABSENT).filter((g) => !getters().includes(g))).toEqual([])
  })
})
