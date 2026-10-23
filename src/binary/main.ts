/**
 * Entry of the compiled Walnut file (scripts/build-binary.mjs). The npm build
 * keeps bin/open-walnut.js; this is the same routing plus the helper programs a
 * Node install runs as separate files.
 *
 *   walnut <command> ...             the CLI (data commands take the slim cli-fast entry)
 *   walnut __daemon --start          the session daemon (src/providers/daemon-standalone.ts);
 *                                    `--start`, `--stop` and `--service` alone mean the same
 *   walnut __selftest                checks the file's own parts without a server (src/binary/selftest.ts)
 *   walnut walnut <args> | wn <args> the on-host `walnut` the daemon's PATH shim runs
 *   walnut <runtime root>/<script>   a program a Node build starts as a file (src/binary/bundled-modules.ts)
 *
 * Excluded from tsc like daemon-standalone.ts, which it imports.
 */
// First, always: unpacks the embedded files and points import.meta.url at them.
import { runtimeRoot } from './runtime-root.js'
import { bundledModule } from '../lib/single-file.js'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Code written for Node re-runs Walnut as `execPath argv[1] ...` (the MCP mount,
// the ephemeral child, a restart). Here argv[1] is the virtual entry
// (/$bunfs/root/walnut) and execPath is this file: accept that leading self path.
const userArgs = process.argv.slice(2)
if (userArgs[0] !== undefined && (userArgs[0] === process.argv[1] || userArgs[0] === process.execPath)) {
  userArgs.shift()
  process.argv.splice(2, 1)
}

/**
 * A script inside the unpacked runtime tree, run the way node would run it: a
 * bundled helper (placeholder on disk) or JS shipped as a file (the Codex and Pi
 * ACP adapters). Nothing outside the tree is ever run this way.
 */
function runtimeScript(arg: string): boolean {
  if (!path.isAbsolute(arg) || !/\.(c|m)?js$/.test(arg)) return false
  const rel = path.relative(runtimeRoot, arg)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  return bundledModule(arg) !== null || fs.existsSync(arg)
}

const first = userArgs[0]
const LITE = new Set(['tools', 'add', 'tasks', 'done', 'recall', 'projects', 'sessions', 'start', 'guide', 'peers', 'trigger-check'])

if (first === '__selftest') {
  const { runSelftest } = await import('./selftest.js')
  process.exit(await runSelftest())
} else if (first === '__daemon' || first === '--start' || first === '--stop' || first === '--service') {
  // The daemon reads its own argv (`--start`, `--stop`, `--service`, `--version`). Its
  // three lifecycle flags also work bare (no CLI meaning), so the file stands in for a
  // daemon binary wherever one is started that way (the daemon service install).
  if (first === '__daemon') process.argv.splice(2, 1)
  await import('../providers/daemon-standalone.js')
} else if (first === 'walnut' || first === 'wn') {
  // The daemon copies this file as its shim core and its PATH shim runs `<copy> walnut <args>`.
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  process.exit(await runWalnutCli(userArgs.slice(1)))
} else if (first !== undefined && runtimeScript(first)) {
  // As under node: argv[1] is the program's own path, its arguments follow.
  process.argv.splice(1, 2, first)
  await (bundledModule(first)?.() ?? import(pathToFileURL(first).href))
} else {
  const sub = userArgs.find((a) => !a.startsWith('-'))
  const fast = process.env.WALNUT_CLI_DIRECT !== '1'
    && ((sub !== undefined && LITE.has(sub)) || (!sub && (userArgs.includes('--version') || userArgs.includes('-V'))))
  if (fast) await import('../cli-fast.js')
  else await import('../cli.js')
}
