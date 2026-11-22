/**
 * A stand-in for `walnut standby receive` on the standby host (remote-transport e2e): runs the
 * op as the CLI does, but an apply stops at the commit point argv[2] names ('-' for none):
 *   <point>              kills itself with SIGKILL there, as a power loss or a kill would
 *   wait:<point>         waits there until the file named by STANDBY_FIXTURE_RESUME exists
 *   sleep:<point>:<ms>   sleeps there that long (an apply longer than a command's limit)
 * Each apply that reaches its end appends its batch to the file STANDBY_FIXTURE_LOG names.
 */
import fs from 'node:fs'
import { RECEIVE_MARK, receiveApply, runReceiveOp } from '../../../../src/core/standby/receive.js'

const [how, word1, word2, op, dir, ...rest] = process.argv.slice(2)
if (word1 !== 'standby' || word2 !== 'receive') throw new Error('expected: <point> standby receive <op> <dir> ...')
const o: Record<string, string | boolean> = {}
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
  if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) o[k] = rest[++i]
  else o[k] = true
}
const [mode, point, ms] = how.includes(':') ? how.split(':') : ['kill', how, '0']
const at = async (name: string) => {
  if (name !== point) return
  if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
  if (mode === 'sleep') await new Promise((r) => setTimeout(r, Number(ms)))
  if (mode === 'wait') while (!fs.existsSync(String(process.env.STANDBY_FIXTURE_RESUME))) await new Promise((r) => setTimeout(r, 100))
}
try {
  const answer = op === 'apply' && how !== '-'
    ? await receiveApply(dir, String(o.upload), { verify: o.verify === true, status: typeof o.status === 'string' ? o.status : undefined, hooks: { point: at } })
    : await runReceiveOp(op, dir, o)
  if (op === 'apply' && process.env.STANDBY_FIXTURE_LOG) fs.appendFileSync(process.env.STANDBY_FIXTURE_LOG, `${(answer as { commit: { batch: number } }).commit.batch}\n`)
  console.log(RECEIVE_MARK + JSON.stringify(answer))
} catch (err) {
  console.log(RECEIVE_MARK + JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  process.exitCode = 1
}
