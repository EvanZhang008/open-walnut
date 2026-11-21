/**
 * Child process for tests/core/standby/target-crash.test.ts: commits the batch manifest at
 * argv[3] to the target at argv[2] and kills itself with SIGKILL at the named commit point
 * argv[4], as a power loss would stop it there (no finally, no cleanup).
 */
import fs from 'node:fs'
import { StandbyTarget } from '../../../../src/core/standby/target.js'

const [dir, manifestFile, point] = process.argv.slice(2)
const target = new StandbyTarget(dir)
await target.commit(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), {
  point: (name) => { if (name === point) process.kill(process.pid, 'SIGKILL') },
})
console.log('committed')
