/**
 * The entry of the companion package (package.ts): `package/dist/cli.js`, beside
 * the compiled walnut file `package/walnut`.
 *
 * Every box starts a build as `<runtime> app/<id>/dist/cli.js <args>`: the
 * launcher (scripts/cloud/companion-launch.mjs) for the server, the install
 * script for its `--version` check, the smoke boot for its test start. A box
 * set up before the compiled file runs that with Node, a newer one with bun; so
 * this script is plain JavaScript with node: builtins only, and all it does is
 * start `../walnut` with the same arguments, pass the stop signals on, and end
 * with the file's own exit. That is how a box of any age takes the file with
 * no step on the box (docs/plan/walnut-single-binary.md, "The cloud companion").
 *
 * Under the launcher (WALNUT_COMPANION_LAUNCHER=1, `web`) it also keeps the
 * file's pid in R/companion/file-server.pid. The launcher stops a server left
 * from an earlier start by the pid it started, which is this script: if this
 * script was killed hard while the file kept running (SIGKILL, the OOM killer),
 * the file would hold the port forever, so the next start stops it first, and
 * only when that pid still runs a walnut file's `web` under R/app.
 */

export const COMPANION_FILE_NAME = 'walnut'

export const COMPANION_SHIM_JS = String.raw`#!/usr/bin/env node
// The companion package's entry (written by src/core/companion-build/shim.ts):
// starts the compiled walnut file beside it (../walnut) with the same
// arguments, passes stop signals on, and ends with its exit. Plain JavaScript
// with node: builtins only: a box runs it with Node or with bun.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const say = (msg) => console.error('[companion-shim] ' + msg)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'walnut')
const args = process.argv.slice(2)
const env = { ...process.env }
// A box running the compiled file starts this script with that file told to be
// bun (BUN_BE_BUN=1); the file below must answer as Walnut.
delete env.BUN_BE_BUN

const root = process.env.WALNUT_COMPANION_ROOT || path.join(os.homedir(), '.open-walnut-host')
const pidFile = path.join(root, 'companion', 'file-server.pid')
const served = process.env.WALNUT_COMPANION_LAUNCHER === '1' && args[0] === 'web'

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
function commandLine(pid) {
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ') } catch { /* not Linux */ }
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  } catch { return '' }
}

// A file server whose shim died hard still holds the port: stop it, but only
// when the pid still runs a walnut file's web under this root's app dir.
async function stopOrphan() {
  let pid = NaN
  try { pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) } catch { return }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return
  const cmd = commandLine(pid)
  if (!cmd.includes(path.join(root, 'app') + path.sep) || !cmd.includes(path.sep + 'walnut web')) return
  say('a walnut file from an earlier start (pid ' + pid + ') is still running; sending SIGTERM')
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(200)) {
    if (!alive(pid)) return
  }
  say('pid ' + pid + ' did not stop; sending SIGKILL')
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

async function main() {
  if (served) await stopOrphan()
  const child = spawn(file, args, { stdio: 'inherit', env })
  child.on('error', (err) => { say('could not start ' + file + ': ' + err.message); process.exit(1) })
  if (served && child.pid) {
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true })
      fs.writeFileSync(pidFile + '.tmp', child.pid + '\n')
      fs.renameSync(pidFile + '.tmp', pidFile)
    } catch (err) { say('could not record the file pid: ' + err.message) }
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig) } catch { /* gone */ } })
  }
  child.on('exit', (code, signal) => {
    if (served) {
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(child.pid)) fs.rmSync(pidFile, { force: true }) } catch { /* none */ }
    }
    process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1))
  })
}

main().catch((err) => { say('failed: ' + (err && err.stack ? err.stack : err)); process.exit(1) })
`
