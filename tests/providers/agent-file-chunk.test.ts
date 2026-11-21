/**
 * A subagent file's reads into whole lines (src/providers/agent-file-chunk.ts): capped reads inside a
 * server's process never cut a line in two, however long; an uncapped read keeps a daemon program's
 * behaviour.
 */
import { describe, expect, it } from 'vitest'
import { agentReadSize, takeAgentLines, type AgentFileState } from '../../src/providers/agent-file-chunk.js'

/** Polls `file` as pollData does, reading the bytes the state asks for each tick. */
function pollAll(file: Buffer, cap: number | null, state: AgentFileState = { offset: 0 }): string[][] {
  const ticks: string[][] = []
  for (let i = 0; i < 10_000; i++) {
    const n = agentReadSize(state, file.length, cap)
    if (n === 0) break
    ticks.push(takeAgentLines(state, file.subarray(state.offset, state.offset + n), file.length))
  }
  return ticks
}

describe('agent file chunks', () => {
  it('a 2 MB line under a 1 MB cap arrives whole, once, after the lines before it', () => {
    const big = JSON.stringify({ type: 'user', content: 'x'.repeat(2 * 1024 * 1024) })
    const file = Buffer.from(`{"a":1}\n${big}\n{"b":2}\n`)
    const ticks = pollAll(file, 1024 * 1024)
    const lines = ticks.flat()
    expect(lines).toEqual(['{"a":1}', big, '{"b":2}'])
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
    expect(ticks.length).toBeGreaterThan(1)
  })

  it('a capped read stops at its last newline and the next one starts right after it', () => {
    const file = Buffer.from('aaaa\nbbbb\ncccc\n')
    const state: AgentFileState = { offset: 0 }
    expect(takeAgentLines(state, file.subarray(0, 12), file.length)).toEqual(['aaaa', 'bbbb'])
    expect(state.carry?.toString()).toBe('cc')
    expect(takeAgentLines(state, file.subarray(12), file.length)).toEqual(['cccc'])
    expect(state.carry).toBeUndefined()
  })

  it('a multi-byte character split by the cap is kept whole', () => {
    const file = Buffer.from('你好世界\n')
    const lines = pollAll(file, 4).flat()
    expect(lines).toEqual(['你好世界'])
  })

  it('uncapped (a daemon program) sends what it read, a trailing partial line included', () => {
    const file = Buffer.from('one\ntwo-partial')
    const state: AgentFileState = { offset: 0 }
    expect(pollAll(file, null, state)).toEqual([['one', 'two-partial']])
    expect(state.offset).toBe(file.length)
  })

  it('a file that grows: the carried part joins the bytes appended later', () => {
    const state: AgentFileState = { offset: 0 }
    let file = Buffer.from('start-of-a-long-line')
    // Capped and more to come: only part of the line is on disk yet, cap smaller than it.
    expect(takeAgentLines(state, file.subarray(0, 5), file.length)).toEqual([])
    file = Buffer.concat([file, Buffer.from('-end\nnext\n')])
    const rest = pollAll(file, 8, state).flat()
    expect(rest).toEqual(['start-of-a-long-line-end', 'next'])
  })

  it('nothing to read when the file did not grow', () => {
    expect(agentReadSize({ offset: 10 }, 10, 1024)).toBe(0)
    expect(agentReadSize({ offset: 10 }, 4, null)).toBe(0)
  })
})
