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
