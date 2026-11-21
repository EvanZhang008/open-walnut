/**
 * A standby target behind a REAL session daemon (the standalone twin) and the real walnut CLI
 * on the receiving side (`bun src/cli.ts standby receive ...`, run by the daemon's exec.script):
 * batches arrive whole; a link dropped under a batch, and a daemon killed and started again,
 * are waited out; a receiving process killed at each commit point leaves a whole batch, and
 * the next batch goes on from there; the receiving side never writes its own Walnut home.
 *
 * MACHINE SAFETY: the daemon's HOME, dirs and Walnut home are temp paths; the daemon is
 * SIGKILLed at the end; nothing here reads a real home or makes a network call.
 */
import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RemoteStandbyTarget } from '../../../src/core/standby/remote-transport.js'
import { standbyStatus, takeBatch, verifyStandby } from '../../../src/core/standby/index.js'
import { testBun } from '../../helpers/bun-runtime.js'
import { leaderPlainFiles, sandbox, seedHome, sha, walk, write, type Sandbox } from './helpers.js'
import { bootStandbyTwin, type StandbyTwin } from './twin-link.js'

const BUN = testBun()
const ROOT = path.resolve(__dirname, '../../..')
const CLI = [BUN ?? 'bun', path.join(ROOT, 'src/cli.ts')]
const DIE = (point: string) => [BUN ?? 'bun', path.join(__dirname, 'fixtures/receive-and-die.ts'), point]

let sb: Sandbox
let twin: StandbyTwin | null = null
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  await twin?.stop()
  twin = null
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})
const settle = () => new Promise((r) => setTimeout(r, 30))

async function setUp(name: string): Promise<StandbyTwin> {
  sb = await sandbox(name)
  dbs.push(...seedHome(sb.home).dbs)
  write(sb.home, 'big/more.bin', crypto.randomBytes(6 * 1024 * 1024))
  await settle()
  twin = await bootStandbyTwin(path.join(sb.root, 'twin'), BUN!)
  return twin
}

const target = (t: StandbyTwin, walnut = CLI, linkWaitMs = 30_000) =>
  new RemoteStandbyTarget({ connect: () => t.connect(), dir: sb.target, walnut, linkWaitMs })
const batch = (r: RemoteStandbyTarget) => takeBatch({ home: sb.home, transport: r, stagingDir: path.join(sb.root, 'staging') })

async function expectCopyIsHome(): Promise<void> {
  for (const rel of leaderPlainFiles(sb.home)) expect(sha(path.join(sb.target, 'copy', rel)), rel).toBe(sha(path.join(sb.home, rel)))
  expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
}

describe.skipIf(!BUN)('a standby target behind a real daemon', () => {
  it('takes batches through the real CLI there, and that side never writes its own Walnut home', async () => {
    const t = await setUp('twin-basic')
    const homeBefore = walk(t.home)
    const walnutHomeBefore = walk(t.walnutHome)
    const r = target(t)
    const first = await batch(r)
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    await expectCopyIsHome()
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    const second = await batch(r)
    expect(second.ok && second.commit).toMatchObject({ batch: 2, written: 1 })
    await expectCopyIsHome()
    const v = await r.verify({ deep: true })
    expect(v.verify.drift).toEqual([])
    expect(walk(t.walnutHome)).toEqual(walnutHomeBefore)
    // Only bun's own transpile cache (this test runs the CLI from source) may appear in HOME.
    const own = (p: string) => !p.startsWith('.bun/')
    expect(walk(t.home).filter(own)).toEqual(homeBefore.filter(own))
  }, 180_000)

  it('waits out a link dropped under a batch, and a daemon killed and started again', async () => {
    const t = await setUp('twin-drop')
    let writes = 0
    const connect = t.connect
    // Drop the socket after the 3rd command of the batch, and kill the daemon after the 8th.
    const wrapped = new RemoteStandbyTarget({
      dir: sb.target, walnut: CLI, linkWaitMs: 60_000,
      connect: async () => {
        const l = await connect()
        return {
          async send(cmd, params, timeoutMs) {
            const n = ++writes
            if (n === 3) setTimeout(() => t.drop(), 0)
            if (n === 8) { await t.kill(); setTimeout(() => { void t.start() }, 1_000) }
            return l.send(cmd, params, timeoutMs)
          },
        }
      },
    })
    const out = await batch(wrapped)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(wrapped.stats.resent).toBeGreaterThan(0)
    await expectCopyIsHome()
  }, 180_000)

  for (const [point, current] of [['files-built', 1], ['mid-swap', 1], ['state-written', 2]] as const) {
    it(`a receiving process killed at ${point} leaves batch ${current} whole, and the next batch goes on`, async () => {
      const t = await setUp(`twin-kill-${point}`)
      expect((await batch(target(t))).ok).toBe(true)
      write(sb.home, 'memory/MEMORY.md', '# second version\n')
      write(sb.home, 'big/more.bin', crypto.randomBytes(6 * 1024 * 1024))
      await settle()
      const dying = target(t, DIE(point))
      const out = await batch(dying)
      // Killed after its state write: the target took the batch, and the leader says so.
      expect(out.ok, out.ok ? '' : out.reason).toBe(current === 2)
      expect((await standbyStatus(sb.target)).batch).toBe(current)
      const next = await batch(target(t))
      expect(next.ok, next.ok ? '' : next.reason).toBe(true)
      await expectCopyIsHome()
      expect(fs.existsSync(path.join(sb.target, '.apply'))).toBe(false)
    }, 180_000)
  }
})
