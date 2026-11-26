/**
 * The mock CLI files every user line a turn starts on under the uuid it was sent
 * with, as the real CLI does (stream-json `uuid`). 2026-11-05: a line taken by the
 * `onUserLine` path (and a queued line started after a turn) kept the previous
 * turn's uuid or none, so the transcript row got another id than its anchor, and a
 * question's follow-up in the Tree Mode demo was drawn on the main conversation.
 * Every stdin branch that starts a turn on a user line must take its uuid.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, 'mock-claude.mjs'), 'utf8')

describe('the mock CLI files a user line under its own uuid', () => {
  it('every branch that starts a turn on a user line sets lastInputUserUuid', () => {
    // A user line that starts a turn: it resolves a waiting turn, or it is handed to onUserLine.
    const branches = [...SRC.matchAll(/else if \(parsed\.type === 'user'[^\n]*&& (pendingUserResolve|onUserLine)\) \{([\s\S]*?)\n {8}\}/g)]
    expect(branches.map((m) => m[1]).sort()).toEqual(['onUserLine', 'pendingUserResolve'])
    for (const m of branches) expect(m[2], `${m[1]} branch`).toMatch(/lastInputUserUuid = parsed\.uuid/)
  })

  it('a queued line takes its own uuid when its turn starts', () => {
    const queued = /const queued = queuedUserLines\.shift\(\);\s*if \(queued\) \{([\s\S]*?)\n\s{4}\}/.exec(SRC)
    expect(queued?.[1]).toMatch(/lastInputUserUuid = queued\.uuid/)
  })
})

/**
 * 2026-11-25: the line the mock CLI took at its first stdin read was named (`command_lifecycle`
 * queued, started) only in the die modes, so a fresh session whose first line came over stdin
 * kept that line's queue row for good and every message behind it waited. Claude Code names
 * every line it takes; so does every path here that takes one.
 */
describe('the mock CLI names every user line it takes', () => {
  it('every stdin branch that handles a user line names it (queued, or queued then started)', () => {
    const branches = [...SRC.matchAll(/\} else if \(parsed\.type === 'user'[^\n]*\{([\s\S]*?)(?=\n {8}\} else if|\n {8}\}\n)/g)].map((m) => m[0].split('\n')[0].trim() + m[1])
    expect(branches.length).toBeGreaterThanOrEqual(4)
    for (const b of branches) expect(b, b.split('\n')[0]).toMatch(/announceStarted\(parsed\)|takeLineMidTurn\(parsed\)|command_lifecycle[^\n]*state: 'queued'/)
    // takeLineMidTurn names the line itself, queued then started.
    const mid = /function takeLineMidTurn\(parsed\) \{([\s\S]*?)\n\}/.exec(SRC)?.[1] ?? ''
    expect(mid).toMatch(/for \(const state of \['queued', 'started'\]\)/)
  })

  it('a queued line is named started when its turn starts', () => {
    const queued = /const queued = queuedUserLines\.shift\(\);\s*if \(queued\) \{([\s\S]*?)\n\s{4}\}/.exec(SRC)?.[1] ?? ''
    expect(queued).toMatch(/command_uuid: queued\.uuid, state: 'started'/)
  })

  it('the line taken at the first stdin read is named queued then started in every mode', () => {
    const block = /if \(inputFormat === 'stream-json' && firstReadUuid\) \{([\s\S]*?)\n\}/.exec(SRC)?.[1] ?? ''
    expect(block).toMatch(/for \(const state of \['queued', 'started'\]\)/)
    expect(block).toMatch(/command_uuid: firstReadUuid/)
    expect(block).not.toMatch(/DIE_COUNT_FILE|die-after-start/)
    // The first read's only take sets it.
    expect(SRC.match(/firstReadUuid = parsed\.uuid/g)).toHaveLength(1)
  })
})
