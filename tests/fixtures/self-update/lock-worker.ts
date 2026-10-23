/**
 * One updater process for tests/core/self-update/install-lock-multiprocess.test.ts.
 *
 *   lock <root> <startFile> <holdMs> <judgeMs> <count>
 *     takes the update lock <count> times (a busy lock is tried again for 20 s),
 *     judging every owner slowly (<judgeMs>) to widen the takeover race, holds
 *     it <holdMs> and marks `<root>/inside` exclusively while it does: failing
 *     to means another holder is inside too.
 *   install <root> <target> <version> <registry> <startFile>
 *     installFileVersion into the layout at <root>.
 *
 * Prints `ready`, waits for <startFile>, then one JSON line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { installFileVersion } from '../../../src/core/self-update/binary-install.js'
import { pidAlive, takeLock } from '../../../src/core/self-update/install-lock.js'

const [mode, root, ...rest] = process.argv.slice(2)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const startFile = mode === 'lock' ? rest[0]! : rest[3]!
process.stdout.write('ready\n')
while (!fs.existsSync(startFile)) await sleep(2)

if (mode === 'lock') {
  const [, holdMs, judgeMs, count] = rest.map(Number)
  const slowAlive = (pid: number) => {
    const until = Date.now() + judgeMs!
    while (Date.now() < until) { /* a slow judge, on purpose */ }
    return pidAlive(pid)
  }
  let overlaps = 0
  let got = 0
  let busy = 0
  const deadline = Date.now() + 20_000
  while (got < count! && Date.now() < deadline) {
    let release: (() => void) | null = null
    try {
      release = await takeLock(root!, { alive: slowAlive })
    } catch (err) {
      if (!/another update/.test((err as Error).message)) throw err
      busy++
      await sleep(5 + Math.random() * 20)
      continue
    }
    try {
      fs.writeFileSync(path.join(root!, 'inside'), String(process.pid), { flag: 'wx' })
    } catch {
      overlaps++
    }
    await sleep(holdMs!)
    fs.rmSync(path.join(root!, 'inside'), { force: true })
    release()
    got++
  }
  process.stdout.write(`${JSON.stringify({ overlaps, got, busy })}\n`)
} else {
  const [target, version, registry] = rest
  try {
    const done = await installFileVersion({ install: { root: root!, target: target!, version: '0.0.0' }, version: version!, registry: registry! })
    process.stdout.write(`${JSON.stringify({ ok: true, from: done.from, to: done.to })}\n`)
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`)
  }
}
