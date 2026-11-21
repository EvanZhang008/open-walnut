/**
 * A process that takes the instance lock and keeps it (instance.test.ts runs several).
 * Prints one JSON line when it took it or was refused, and one when it finds it lost
 * (then exits 3, as the wiring's process stops).
 */
import { acquireInstanceLock } from '../../../../../src/core/leader/permit/instance-lock.js'

const [path, staleMs, beatMs] = process.argv.slice(2)
const r = await acquireInstanceLock({
  path: path!,
  staleAfterMs: Number(staleMs),
  beatEveryMs: Number(beatMs),
  onLost: (by) => {
    console.log(JSON.stringify({ lost: true, by: by?.pid ?? null }))
    process.exit(3)
  },
})
console.log(JSON.stringify(r.ok ? { ok: true, pid: process.pid } : { ok: false, owner: r.owner?.pid ?? null, reason: r.reason }))
if (!r.ok) process.exit(2)
r.lock.start()
setInterval(() => {}, 1_000)
