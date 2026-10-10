/**
 * The Search settings rows for the followers' copies of the index (the cloud
 * companion, a server on a host; web/src/components/settings/sections/
 * companion-search-copy.ts): one sentence per server and state, a warning when
 * one runs without the memory Auto asks for, and the confirm before On whenever
 * a listed server is not known to have that memory.
 */
import { describe, expect, it } from 'vitest'
import {
  followerSearchHelp, memoryWarningMessage, onNeedsMemoryWarning, visibleFollowers, gb,
  type FollowerSearchStatus,
} from '../../web/src/components/settings/sections/companion-search-copy'

const at = (s: Partial<FollowerSearchStatus>): FollowerSearchStatus => ({
  id: 'companion', kind: 'companion', label: 'Cloud companion', mode: 'auto', state: 'ready', checkedAt: 0, ...s,
})
const host = (s: Partial<FollowerSearchStatus>): FollowerSearchStatus => at({ id: 'host:devbox', kind: 'host', label: 'devbox', ...s })

describe('follower search rows', () => {
  it('lists only the servers the Mac reaches', () => {
    expect(visibleFollowers(null)).toEqual([])
    expect(visibleFollowers([at({ state: 'unavailable' })])).toEqual([])
    expect(visibleFollowers([at({ state: 'unavailable' }), host({ state: 'memory' })]).map((f) => f.id)).toEqual(['host:devbox'])
  })

  it('says one sentence per state, a warning where something is wrong', () => {
    expect(followerSearchHelp(at({ state: 'ready', docs: 12_342 }))).toEqual({ text: 'Ready: 12,342 items.' })
    expect(followerSearchHelp(at({ state: 'ready', reason: 'forced', totalMb: 3_900, needMb: 2_600 }))).toEqual({
      text: 'On with little memory: the model takes about 2.5 GB of its 3.8 GB.', warning: true,
    })
    expect(followerSearchHelp(at({ state: 'syncing', pending: 3_120 })).text).toBe('Copying this index: 3,120 items left.')
    expect(followerSearchHelp(at({ state: 'memory', totalMb: 3_900, autoMinMb: 5_600 })).text).toBe('Off: Auto needs 5.5 GB of memory and it has 3.8 GB.')
    expect(followerSearchHelp(at({ state: 'off', mode: 'off' })).text).toBe('Off: it searches by keyword while this Mac is away.')
    expect(followerSearchHelp(at({ state: 'error', error: 'HTTP 502' }))).toEqual({ text: 'Couldn\'t reach it: HTTP 502.', warning: true })
    expect(followerSearchHelp(at({ state: 'unsupported' })).text).toBe('It runs an older build that keeps no copy yet.')
    expect(gb(7_814)).toBe('7.6 GB')
  })

  it('On warns unless every listed server is known to have the memory, and names the ones that lack it', () => {
    expect(onNeedsMemoryWarning('auto', [])).toBe(false)
    expect(onNeedsMemoryWarning('on', [])).toBe(true)
    expect(onNeedsMemoryWarning('on', [at({ totalMb: 7_814, autoMinMb: 5_600 })])).toBe(false)
    expect(onNeedsMemoryWarning('on', [at({ totalMb: 7_814 }), host({ state: 'memory', totalMb: 3_900 })])).toBe(true)
    // A server that never said how much it has (an older build) is not known to have it.
    expect(onNeedsMemoryWarning('on', [at({ totalMb: 7_814 }), host({ state: 'unsupported' })])).toBe(true)
    expect(onNeedsMemoryWarning('off', [host({ totalMb: 1_000 })])).toBe(false)
    expect(memoryWarningMessage([at({ totalMb: 7_814 }), host({ totalMb: 3_900, needMb: 2_600 })])).toBe(
      'devbox has 3.8 GB of memory. The search model takes about 2.5 GB on each server, which can leave too little for the server itself and make it slow.',
    )
    expect(memoryWarningMessage([])).toContain('Auto turns it on only on a server with 5.5 GB')
  })
})
