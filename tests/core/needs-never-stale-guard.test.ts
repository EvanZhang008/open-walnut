/**
 * No ask of the user stays NOT VERIFIED past a day without its own task checking it again
 * (sessions/needs-recheck.ts, user-status.ts stampChecked; 2026-11-04, Main's reflection: asks on
 * four nodes read NOT VERIFIED for 18 to 21 hours, two in Main's Brief for 4 to 5 days, and were
 * checked only when Main chased them). The causes, each pinned here:
 *  - a live trigger watching the ask (watches:"ask") skipped the re-check, while its runs counted
 *    for nothing, so the ask aged behind it for days: its runs are now the ask's check;
 *  - after MAX_RECHECKS in a row the re-check stopped for good: it now comes once a day.
 * Every skip in the re-check pass is listed with its reason, so a new one fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { NEEDS_RECHECK_MS, UNVERIFIED_AFTER_MS, deriveUserStatus, type StatusReport, type UserStatus } from '../../src/core/user-status.js'
import { MAX_RECHECKS, RECHECK_AFTER_CAP_MS, recheckDue } from '../../src/core/sessions/needs-recheck.js'
import { askCheckedAtOf } from '../../src/core/user-status-sync.js'
import { askKey } from '../../src/core/same-ask.js'

const NOW = Date.parse('2026-11-04T18:00:00Z')
const H = 3_600_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const asks = (at: string): StatusReport => ({ at, state: 'needs', ask: 'Log in once with your master password' })
const DAY = 24 * H

describe('an ask is never left unverified past a day', () => {
  it('every re-check state comes due again within a day of the last look', () => {
    const shown = (checkedAt: string): UserStatus => ({ state: 'needs', source: 'session', ask: 'Log in once', checkedAt })
    for (let count = 0; count <= MAX_RECHECKS + 4; count++) {
      for (const sinceNote of [0, H, NEEDS_RECHECK_MS, DAY - H]) {
        const task = { id: 't', phase: 'NEED_ACTION', status: 'todo', user_status: shown(ago(NEEDS_RECHECK_MS + sinceNote + H)),
          needs_recheck: count ? { at: ago(sinceNote), count, ask: 'Log in once' } : undefined } as never
        // Step the clock forward from now: some point within a day must be due.
        let due = false
        for (let t = NOW; t <= NOW + DAY + 10 * 60_000 && !due; t += 10 * 60_000) due = recheckDue(task, { nowMs: t })
        expect(due, `count ${count}, last note ${sinceNote / H}h ago: no re-check within a day`).toBe(true)
      }
    }
    expect(RECHECK_AFTER_CAP_MS).toBeLessThanOrEqual(DAY)
  })

  it('a trigger armed to watch the ask checks it each run; any other trigger of the task does not', () => {
    const old = ago(20 * H)
    const watched = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(old), phaseChangedAt: old, askCheckedAt: ago(10 * 60_000) }, NOW)
    expect(watched).toMatchObject({ state: 'needs', checkedAt: ago(10 * 60_000), checkedBy: 'check' })
    expect(watched.unverified).toBeUndefined()
    const other = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(old), phaseChangedAt: old, checkRanAt: ago(10 * 60_000) }, NOW)
    expect(other).toMatchObject({ checkedAt: old, checkedBy: 'session', unverified: true })
    // A watch that stopped checking ages like any other ask, and the re-check comes back.
    const stale = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(old), phaseChangedAt: old, askCheckedAt: ago(UNVERIFIED_AFTER_MS + H) }, NOW)
    expect(stale.unverified).toBe(true)
    expect(recheckDue({ id: 't', phase: 'NEED_ACTION', status: 'todo', user_status: stale } as never, { nowMs: NOW })).toBe(true)
  })

  it('only a watch on the ask, by an armed trigger whose check ran without an error, counts', () => {
    const ASK = 'Log in once with your master password'
    const key = askKey(ASK)
    const checks = new Map([['trigger:tr-ask', ago(H)], ['trigger:tr-letter', ago(1000)], ['t', ago(1000)]])
    expect(askCheckedAtOf({ recheck_watch: [{ trigger: 'tr-ask', watches: 'ask', at: ago(DAY), key }, { trigger: 'tr-letter', watches: 'lt-abcd', at: ago(DAY) }] }, checks, ASK)).toBe(ago(H))
    expect(askCheckedAtOf({ recheck_watch: [{ trigger: 'tr-letter', watches: 'lt-abcd', at: ago(DAY) }] }, checks, ASK)).toBeNull()
    expect(askCheckedAtOf({ recheck_watch: [{ trigger: 'gone', watches: 'ask', at: ago(DAY), key }] }, checks, ASK)).toBeNull()
    // A watch armed for another ask, or for none, checks nothing of this one.
    expect(askCheckedAtOf({ recheck_watch: [{ trigger: 'tr-ask', watches: 'ask', at: ago(DAY), key: askKey('Sign in to the VPN again') }] }, checks, ASK)).toBeNull()
    expect(askCheckedAtOf({ recheck_watch: [{ trigger: 'tr-ask', watches: 'ask', at: ago(DAY) }] }, checks, ASK)).toBeNull()
    const sync = fs.readFileSync(path.resolve(__dirname, '../../src/core/user-status-sync.ts'), 'utf8')
    expect(sync).toMatch(/triggerRunState\(job\) !== 'armed'[\s\S]*?lastCheck\?\.outcome !== 'error'[\s\S]*?`trigger:\$\{job\.id\}`/)
  })

  it('every task the re-check pass skips is listed with why', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/sessions/needs-recheck.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function runNeedsRecheck'), src.indexOf('let bootTimer'))
    const skips = [...body.matchAll(/if \(([^\n]+?)\) continue;|\n(\s+)continue;/g)].map((m) => (m[1] ?? 'cleared').replace(/\s+/g, ' ').trim())
    const KNOWN: Record<string, string> = {
      cleared: 'it asks the user nothing now (waiting, read, done): its count is cleared, the next ask starts fresh',
      "task.plugin_only || task.user_status?.state !== 'needs' || (source !== 'session' && source !== 'choice')": 'not a session\'s own ask or a Board choice: Walnut\'s live records (a prompt, a letter, an error) need no check',
      "!recheckDue(task, { nowMs, snoozeEndedMs: snoozeEndedMs(task, byId, nowMs), unknownSince: startedAt || nowMs, ...(ephemeral ? { notBefore: startedAt } : {}) })": 'checked recently (by the session or the trigger watching the ask), snoozed, or noted within the gap (at most a day, pinned above)',
      'quieted.has(task.id)': 'the user stopped or quieted its team: resumed, it is due at once',
      "source === 'choice' && !choice": 'a choice status with no Board named: nobody to ask',
      "!owner || owner.phase === 'COMPLETE' || owner.status === 'done'": 'the Board owner is finished: its choice goes with it',
      'orgOff && isOrgNode(owner)': 'the org is off: Main and the VPs are woken for nothing',
      '!target': 'no session left to ask (archived or failed): the task shows its error, not an ask',
    }
    expect(skips.sort(), 'a new skip in runNeedsRecheck: say here why it cannot leave an ask unverified past a day').toEqual(Object.keys(KNOWN).sort())
    // No skip on a live watch: a watch counts only by checking (stampChecked).
    expect(body).not.toMatch(/watchedBy\(/)
  })
})
