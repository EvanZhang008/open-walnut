/**
 * A commit whose batch turns a dir the last batch listed into a file and a file into a dir it
 * lists (src/core/standby/batch-dirs.ts), killed at each point: the copy is the batch that is
 * current, whole, with no drift reported, and the next batch completes it. Written as a probe by
 * review E's third round, which found a rollback removing the previous batch's dir and a
 * cleanup that chmod'ed the new file through a stale dir path.
 *
 * MACHINE SAFETY: every home and target is a temp dir of the test's own; the killed child is
 * the test's own fixture (fixtures/commit-and-die.ts), killed by itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { snapshotTo, standbyStatus, takeBatch, verifyStandby, StandbyTarget, type BatchManifest } from '../../../src/core/standby/index.js'
import { sandbox, write, type Sandbox } from './helpers.js'

let sb: Sandbox
afterEach(async () => { await sb?.cleanup() })
const settle = () => new Promise((r) => setTimeout(r, 40))
const copy = (rel: string) => path.join(sb.target, 'copy', rel)

async function sendWithoutCommit(): Promise<BatchManifest> {
  const target = new StandbyTarget(sb.target)
  await target.init()
  let held: BatchManifest | null = null
  const transport = {
    current: () => target.current(),
    missing: (ids: string[]) => target.missing(ids),
    putChunk: (id: string, data: Buffer) => target.putChunk(id, data),
    commit: async (m: BatchManifest) => { held = m; return { batch: m.batch, written: 0, deleted: 0, unchanged: false } },
  }
  const out = await takeBatch({ home: sb.home, transport, stagingDir: path.join(sb.root, 'staging') })
  expect(out.ok, out.ok ? '' : out.reason).toBe(true)
  return held!
}

function shape(n: 1 | 2): void {
  const a = fs.lstatSync(copy('memory/flip-a'), { throwIfNoEntry: false })
  const b = fs.lstatSync(copy('memory/flip-b'), { throwIfNoEntry: false })
  expect(a?.isDirectory(), 'flip-a is a dir in batch 1').toBe(n === 1)
  expect(a?.isFile(), 'flip-a is a file in batch 2').toBe(n === 2)
  expect(b?.isFile(), 'flip-b is a file in batch 1').toBe(n === 1)
  expect(b?.isDirectory(), 'flip-b is a dir in batch 2').toBe(n === 2)
}

describe('a dir and a file swap places in a commit', () => {
  for (const [point, current] of [['journal-written', 1], ['half-step', 1], ['mid-swap', 1], ['swapped', 1], ['state-written', 2], ['none', 2]] as const) {
    it(`killed at ${point}`, async () => {
      sb = await sandbox(`flip-${point}`)
      write(sb.home, 'memory/MEMORY.md', '# m\n')
      fs.mkdirSync(path.join(sb.home, 'memory/flip-a'), { recursive: true })
      write(sb.home, 'memory/flip-b', 'b file\n')
      await settle()
      const first = await snapshotTo(sb.home, sb.target)
      expect(first.ok, first.ok ? '' : first.reason).toBe(true)
      expect(first.ok && first.manifest.dirs).toEqual(['memory/flip-a'])
      shape(1)
      fs.rmdirSync(path.join(sb.home, 'memory/flip-a'))
      write(sb.home, 'memory/flip-a', 'a file\n')
      fs.rmSync(path.join(sb.home, 'memory/flip-b'))
      fs.mkdirSync(path.join(sb.home, 'memory/flip-b'))
      // A file it replaces too, so the commit passes its half-step point.
      write(sb.home, 'memory/MEMORY.md', '# m, second\n')
      await settle()
      if (point === 'none') {
        const out = await snapshotTo(sb.home, sb.target)
        expect(out.ok, out.ok ? '' : out.reason).toBe(true)
      } else {
        const manifest = await sendWithoutCommit()
        expect(manifest.dirs).toEqual(['memory/flip-b'])
        const file = path.join(sb.root, 'manifest.json')
        fs.writeFileSync(file, JSON.stringify(manifest))
        const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/commit-and-die.ts'), sb.target, file, point], { encoding: 'utf8', timeout: 60_000 })
        expect(child.signal, child.stderr).toBe('SIGKILL')
      }
      const verify = await verifyStandby(sb.target, { deep: true })
      expect(verify.drift).toEqual([])
      expect((await standbyStatus(sb.target)).batch).toBe(current)
      shape(current)
      const next = await snapshotTo(sb.home, sb.target)
      expect(next.ok, next.ok ? '' : next.reason).toBe(true)
      shape(2)
      expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
      const again = await snapshotTo(sb.home, sb.target)
      expect(again.ok && again.commit.unchanged).toBe(true)
    }, 60_000)
  }
})
