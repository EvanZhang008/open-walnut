/**
 * The leader switch's preflight refuses a new leader whose build cannot read session prompts kept
 * only in the prompt table (source-job.ts promptSplitProblem, prompt split design section 3.4): its
 * check reports the store formats it reads, and a store with no such row needs none.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from '../../../../src/lib/sqlite.js'
import { promptSplitProblem, splitPromptRowsIn } from '../../../../src/core/leader/switch/source-job.js'
import { SESSION_STORE_FORMATS } from '../../../../src/core/session-prompts.js'

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }) })

function home(payloads: string[] | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-split-preflight-'))
  homes.push(dir)
  if (payloads) {
    const db = new Database(path.join(dir, 'sessions.sqlite'))
    db.exec('CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, payload TEXT)')
    payloads.forEach((p, i) => db.prepare('INSERT INTO sessions VALUES (?, ?)').run(`s-${i}`, p))
    db.close()
  }
  return dir
}

const OLD = JSON.stringify({ appliedAppendSystemPrompt: 'spawn', profile: { systemPrompt: 'persona' } })
const RELEASE_A = JSON.stringify({ appliedAppendSystemPrompt: 'spawn', appliedAppendSystemPromptRef: { sha256: 'x', bytes: 5 } })
const STRIPPED = JSON.stringify({ profile: { systemPromptRef: { sha256: 'y', bytes: 7, blank: false } } })

describe('the leader switch preflight and the prompt split', () => {
  it('passes any build on a store with no stripped row', () => {
    for (const h of [home(null), home([]), home([OLD, RELEASE_A])]) {
      expect(splitPromptRowsIn(h)).toBe(0)
      expect(promptSplitProblem(h, {})).toBeNull()
    }
  })

  it('refuses a build that does not report the split format on a stripped store, and passes one that does', () => {
    const h = home([OLD, STRIPPED])
    expect(splitPromptRowsIn(h)).toBe(1)
    expect(promptSplitProblem(h, {})).toMatch(/cannot read the session prompts.*sessions-prompts unsplit/)
    expect(promptSplitProblem(h, { storeFormats: { sessionsPromptSplit: 0 } })).not.toBeNull()
    expect(promptSplitProblem(h, { storeFormats: { ...SESSION_STORE_FORMATS } })).toBeNull()
  })

  it('counts a store it cannot read as stripped', () => {
    const h = home(null)
    fs.writeFileSync(path.join(h, 'sessions.sqlite'), 'not a database')
    expect(splitPromptRowsIn(h)).toBe(1)
    expect(promptSplitProblem(h, {})).not.toBeNull()
  })
})
