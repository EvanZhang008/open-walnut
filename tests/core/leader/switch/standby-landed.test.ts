/**
 * "Is the standby copy running" counts from when its last batch landed (committedAt), not from the
 * batch's moment (takenAt), which stays the answer to "what moment is the copy's data from".
 *
 * Found by a 20 GB rehearsal between machines (2026-11-24): after a switch the copy's first batch the
 * other way is the whole home; it landed 490 s after its moment, and the switch right after it was
 * refused by the candidate's preflight as "the standby copy's last batch is 490 s old: is the standby
 * running?", while the standby had just finished a batch.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotTo, standbyStatus } from '../../../../src/core/standby/index.js'
import { UNDER_WAY_MOVED_S, sinceLanded, staleCopyProblem } from '../../../../src/core/leader/switch/target-job.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { return } for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name)) }
    open(d)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('when the standby copy last landed', () => {
  it('the status names both moments: the batch\'s and when the target made it current', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-landed-'))
    dirs.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(home, 'notes', 'a.md'), 'a\n')
    const out = await snapshotTo(home, path.join(root, 'standby'))
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    const s = await standbyStatus(path.join(root, 'standby'))
    expect(s.takenAt).not.toBeNull()
    expect(s.committedAt).not.toBeNull()
    expect(Date.parse(s.committedAt!)).toBeGreaterThanOrEqual(Date.parse(s.takenAt!))
  })

  it('a batch taken 490 s ago that landed 2 s ago is running; the data\'s age stays 490 s', () => {
    const now = Date.parse('2026-11-24T23:12:27Z')
    const s = { ageSeconds: 490, committedAt: new Date(now - 2_000).toISOString() }
    expect(sinceLanded(s, now)).toBe(2)
    expect(s.ageSeconds).toBe(490)
  })

  it('an older state with no landing time: the batch\'s moment, as before; no batch: never recent', () => {
    expect(sinceLanded({ ageSeconds: 400, committedAt: null })).toBe(400)
    expect(sinceLanded({ ageSeconds: null, committedAt: null })).toBe(Infinity)
  })

  // The 2026-11-25 rehearsal (runs/gb20-measure-tracked.log): the switch back at 20 Mbit/s, its standby batch still
  // sending after 300 s, was refused as "the last batch landed 617 s ago: is the standby running?".
  const now = Date.parse('2026-11-25T20:30:00Z')
  const stale = { ageSeconds: 1300, committedAt: new Date(now - 617_000).toISOString() }
  const ago = (s: number) => new Date(now - s * 1000).toISOString()

  it('a recent batch: no problem, whatever is under way', () => {
    expect(staleCopyProblem({ ageSeconds: 40, committedAt: ago(10) }, null, now)).toBeNull()
    expect(staleCopyProblem({ ageSeconds: 40, committedAt: ago(10) }, { since: ago(5), lastAt: ago(1), chunks: 3, bytes: 3 << 20, applying: false }, now)).toBeNull()
  })

  it('an old batch and nothing under way: is the standby running on the leader?', () => {
    const p = staleCopyProblem(stale, null, now)
    expect(p).toMatch(/landed 617 s ago \(more than 300 s\), and no batch is under way here/)
    expect(p).toMatch(/is the standby running on the leader\?/)
    expect(p).not.toMatch(/its standby runs/)
  })

  it('an old batch and one under way that still moves: not caught up yet, its standby runs (wait), never "is it running?"', () => {
    const p = staleCopyProblem(stale, { since: ago(560), lastAt: ago(2), chunks: 1630, bytes: 1630 << 20, applying: false }, now)
    expect(p).toMatch(/not caught up yet, but its standby runs: a batch has been under way here for 560 s/)
    expect(p).toMatch(/1630 chunk\(s\), 1630\.0 MB received, the last 2 s ago/)
    expect(p).toMatch(/wait for it to land, then try again/)
    expect(p).not.toMatch(/is the standby running/)
    // Its apply on this machine, after the last chunk: still moving by the apply's heartbeat.
    expect(staleCopyProblem(stale, { since: ago(560), lastAt: ago(8), chunks: 1630, bytes: 1630 << 20, applying: true }, now)).toMatch(/its apply running/)
  })

  it('an old batch and one that stopped moving: names when it began, and asks for the standby and its link', () => {
    const p = staleCopyProblem(stale, { since: ago(560), lastAt: ago(UNDER_WAY_MOVED_S + 1), chunks: 40, bytes: 40 << 20, applying: false }, now)
    expect(p).toMatch(new RegExp(`the batch that began here at ${ago(560).replace(/[.]/g, '\\.')} has not moved for ${UNDER_WAY_MOVED_S + 1} s`))
    expect(p).toMatch(/is the standby running on the leader, and does its link to this machine carry\?/)
  })
})
