/**
 * The production remote path of a witness call, against a real host daemon runtime (the standalone twin, in a bun
 * process: tests/helpers/witness-twin-proc.ts): the leader opens a `follower` stream of purpose `replica` on the
 * daemon's door, the daemon relays it to the host service's follower link, which hands it to the real leader door,
 * and the witness route on that door answers (witness-transport.ts overDaemonLink opens the same stream with
 * link(host).openStream('follower', 'replica') and requestOver). It shows the daemon really does relay the call to the
 * door, and the route's answers as the leader sees them through it.
 * MACHINE SAFETY: one temp root per run; no CLI starts; the child ends by itself.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const FIXTURE = path.resolve(__dirname, '../../../helpers/witness-twin-proc.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

function run(): Promise<Record<string, any>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-twin-'))
  roots.push(root)
  return new Promise((resolve, reject) => {
    const child = execFile(BUN!, [FIXTURE, root], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const last = String(stdout).trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(last) as Record<string, any>) } catch { reject(new Error(`${error?.message ?? ''}\n${String(stderr).slice(-3000)}\n${String(stdout).slice(-1500)}`)) }
    })
    child.stdin?.end()
  })
}

describe.skipIf(!BUN || process.platform === 'win32')('a witness call through a real host daemon to the leader door of the host service', () => {
  it('is relayed to the door: off is the 404 of a path never had, on and not set up says it holds nothing, set up it takes a grant, and a setup beside records is refused', async () => {
    const r = await run()
    const gone = { status: 404, body: { ok: false, error: 'not_found' } }
    expect(r.neverHad).toEqual(gone)
    expect(r.offRead).toEqual(gone)
    expect(r.onNotSetUp).toEqual({ status: 404, body: { ok: false, error: 'no_witness_here' } })
    expect(r.setup).toEqual({ status: 200, body: { ok: true, made: true } })
    expect(r.setupAgainWithRecords).toEqual({ status: 409, body: { ok: false, error: 'witnesses_hold_records' } })
    expect(r.readAfterSetup.status).toBe(200)
    expect(r.readAfterSetup.body).toMatchObject({ ok: true, round: 2, reply: { witness: 'w1', re: 'read', held: null, epoch: 0 } })
    expect(r.grant.body).toMatchObject({ ok: true, reply: { witness: 'w1', re: 1, ok: true, held: { number: 1, holder: 'A' } } })
    expect(r.readAfterGrant.body).toMatchObject({ round: 3, reply: { held: { number: 1 } } })
    expect(r.otherWalnut.status).toBe(403)
    expect(r.recordOnDisk).toBe(true)
    expect(r.stopCode).toBe(0)
  }, 150_000)
})
