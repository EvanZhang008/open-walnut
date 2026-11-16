/** The files a subagent's answer names (core/subagents/on-host.ts), and the names they come back under. */
import { describe, it, expect } from 'vitest'
import { pathsNamed, freeName, subagentMode, inRunDir } from '../../../src/core/subagents/on-host.js'

describe('the files an answer names', () => {
  it('reads absolute and ~ paths, once each, without trailing punctuation', () => {
    expect(pathsNamed('See /tmp/a/video.mp4. Also `~/out/x.png`, and /tmp/a/video.mp4 again; not a/b or http://x/y.')).toEqual(['/tmp/a/video.mp4', '~/out/x.png'])
  })
  it('reads a path into the run\'s folder by another spelling (a linked home) as that folder\'s', () => {
    const run = '/local/home/u/.open-walnut-transfers/xf-6a237546-b035-4383-8b11-3fab10b7a1b2'
    expect(inRunDir('/home/u/.open-walnut-transfers/xf-6a237546-b035-4383-8b11-3fab10b7a1b2/out/v.mp4', run)).toBe(`${run}/out/v.mp4`)
    expect(inRunDir('/tmp/shot.png', run)).toBe('/tmp/shot.png')
  })
  it('keeps two files of one name apart', () => {
    const used = new Set<string>()
    expect([freeName('v.mp4', used), freeName('v.mp4', used), freeName('v.mp4', used)]).toEqual(['v.mp4', 'v-2.mp4', 'v-3.mp4'])
  })
})

describe('the mode a subagent on another host runs in', () => {
  it('is the caller\'s when it never waits on a person, else Don\'t Ask', () => {
    expect(subagentMode(true, 'bypass')).toBe('bypass')
    expect(subagentMode(false, 'auto')).toBe('auto')
    for (const m of ['default', 'plan', 'accept', 'dontAsk', undefined] as const) expect(subagentMode(false, m)).toBe('dontAsk')
  })
})
