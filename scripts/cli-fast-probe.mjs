/**
 * Run a built dist/cli-fast.js the way a data command does before it replaces
 * the one every session's `walnut` runs: `--version`, `tools list`, then a
 * `tools call`, which reaches no server and must say so. bun runs a bundled
 * module's top level when it is first used, so each command loads its own part
 * of the bundle: a module only `tools call` takes in can throw at load while the
 * other two answer. The build (scripts/build-cli-fast.mjs) and the deploy's
 * publish into the checkout (scripts/publish-serve-root-dist.mjs) refuse an
 * entry that fails it, and the CLI already in place stays.
 *
 * It must reach no Walnut: the env is built from nothing but PATH and the temp
 * dir, with a throwaway HOME, a daemon dir inside it (the default one is shared
 * by every Walnut of the machine) and an API port nothing listens on. A copy of
 * the caller's env carried WALNUT_SERVER_URL, OPEN_WALNUT_HOME, a session's id
 * and socket, or the machine's daemon dir into the probe.
 *
 * Plain JavaScript on node: builtins: the publish may run on Node.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// With this set bun prints, per module it loads, whether it came from bytecode.
// Same as BYTECODE_PROBE_ENV / bytecodeHit in src/binary/selftest.ts (a test pins it).
export const BYTECODE_PROBE_ENV = 'BUN_JSC_verboseDiskCache'
export const BYTECODE_HIT = /^\[Disk Cache\] Cache hit for sourceCode\s*$/m

// The parts of the caller's env the probe keeps: where programs are and where
// temp files go. Everything else (every WALNUT_* and OPEN_WALNUT_* knob, a
// session's id and socket) stays out.
const KEPT_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG']
export const DEAD_API_URL = 'http://127.0.0.1:9'

/** The env the probe runs the entry in: nothing that points at a real Walnut. */
export function probeEnv(home, extra = {}) {
  const env = {}
  for (const name of KEPT_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    WALNUT_DAEMON_DIR: path.join(home, 'daemon'),
    OPEN_WALNUT_API_URL: DEAD_API_URL,
    ...extra,
  }
}

/** The data commands' answer with no server: `--version`, `tools list`, `tools call`. Throws with the reason, else says whether bytecode loaded. */
export function probeCliFast(file, { bun = process.versions.bun ? process.execPath : 'bun', timeoutMs = 60_000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fast-probe-'))
  fs.mkdirSync(path.join(home, 'daemon'))
  const run = (args, env = {}) => spawnSync(bun, [file, ...args], { encoding: 'utf8', timeout: timeoutMs, env: probeEnv(home, env) })
  const failed = (what, r) => {
    const said = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').filter((l) => l.trim() && !l.startsWith('[Disk Cache]'))
    return new Error(`${file} ${what} failed (${r.error ? r.error.message : `exit ${r.status}`})${said.length ? `: ${said.slice(0, 3).join(' | ').slice(0, 400)}` : ''}`)
  }
  try {
    const version = run(['--version'], { [BYTECODE_PROBE_ENV]: '1' })
    if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout)) throw failed('--version', version)
    const list = run(['tools', 'list'])
    if (list.status !== 0 || !list.stdout.includes('task_list')) throw failed('tools list', list)
    // No server: exit 1, "Walnut server not running at ..." (src/ops/executor.ts). A module that fails to load exits 70.
    const call = run(['tools', 'call', 'task_get', '{"id":"probe"}'])
    if (call.status !== 1 || !/not running/.test(call.stderr)) throw failed('tools call task_get', call)
    return { version: version.stdout.trim(), fromBytecode: BYTECODE_HIT.test(version.stderr) }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
