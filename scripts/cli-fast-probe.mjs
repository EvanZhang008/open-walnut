/**
 * Run a built dist/cli-fast.js the way a data command does before it replaces
 * the one every session's `walnut` runs: `--version`, then `tools list`, with
 * an API port nothing listens on, no session socket and a throwaway HOME, so it
 * reaches no Walnut. The build (scripts/build-cli-fast.mjs) and the deploy's
 * publish into the checkout (scripts/publish-serve-root-dist.mjs) refuse an
 * entry that fails it, and the CLI already in place stays.
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

/** The data commands' answer with no server: `--version` and `tools list`. Throws with the reason, else says whether bytecode loaded. */
export function probeCliFast(file, { bun = process.versions.bun ? process.execPath : 'bun', timeoutMs = 60_000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fast-probe-'))
  const run = (args, env = {}) => spawnSync(bun, [file, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      HOME: home,
      OPEN_WALNUT_API_URL: 'http://127.0.0.1:9',
      WALNUT_SESSION_ID: '', WALNUT_AGENT_SOCKET: '', WALNUT_CLI_DIRECT: '',
      ...env,
    },
  })
  const failed = (what, r) => {
    const said = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').filter((l) => l.trim() && !l.startsWith('[Disk Cache]'))
    return new Error(`${file} ${what} failed (${r.error ? r.error.message : `exit ${r.status}`})${said.length ? `: ${said.slice(0, 3).join(' | ').slice(0, 400)}` : ''}`)
  }
  try {
    const version = run(['--version'], { [BYTECODE_PROBE_ENV]: '1' })
    if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout)) throw failed('--version', version)
    const list = run(['tools', 'list'])
    if (list.status !== 0 || !list.stdout.includes('task_list')) throw failed('tools list', list)
    return { version: version.stdout.trim(), fromBytecode: BYTECODE_HIT.test(version.stderr) }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
