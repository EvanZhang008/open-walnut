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
import { sinceLanded } from '../../../../src/core/leader/switch/target-job.js'

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
})
