/**
 * A stand-in for `walnut standby receive` on the standby host (remote-transport e2e): runs the
 * op as the CLI does, but an apply kills itself with SIGKILL at the commit point named by
 * argv[2] ('-' for none), as a power loss or a kill on that machine would stop it there.
 */
import { RECEIVE_MARK, receiveApply, runReceiveOp } from '../../../../src/core/standby/receive.js'

const [point, word1, word2, op, dir, ...rest] = process.argv.slice(2)
if (word1 !== 'standby' || word2 !== 'receive') throw new Error('expected: <point> standby receive <op> <dir> ...')
const o: Record<string, string | boolean> = {}
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
  if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) o[k] = rest[++i]
  else o[k] = true
}
try {
  const answer = op === 'apply' && point !== '-'
    ? await receiveApply(dir, String(o.upload), { verify: o.verify === true, hooks: { point: (name) => { if (name === point) process.kill(process.pid, 'SIGKILL') } } })
    : await runReceiveOp(op, dir, o)
  console.log(RECEIVE_MARK + JSON.stringify(answer))
} catch (err) {
  console.log(RECEIVE_MARK + JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  process.exitCode = 1
}
