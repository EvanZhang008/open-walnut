/**
 * The Node a user runs, for the checks that use Walnut's packages the way a
 * user's npm and Node do (the npm channel, a plugin author's toolchain).
 *
 * Under `bun --bun` (every vitest tier) the first `node` on PATH is bun's own
 * shim, a link to bun, so a bare `node`, or npm (a `#!/usr/bin/env node`
 * script), runs on bun there even on a machine with Node. This finds the real
 * Node behind it.
 */
import fs from 'node:fs'
import path from 'node:path'

const NODE = process.platform === 'win32' ? 'node.exe' : 'node'

/** The first `node` on PATH that is Node, not bun's shim, as its real path; null when there is none. */
export function realNodeOnPath(env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    let real
    try {
      const file = path.join(dir, NODE)
      fs.accessSync(file, fs.constants.X_OK)
      real = fs.realpathSync(file)
    } catch {
      continue
    }
    if (!/^bun(\.exe)?$/i.test(path.basename(real))) return real
  }
  return null
}

/** `env` with `node`'s directory first on PATH, so npm and everything it starts run on that Node. */
export function withNodeFirst(env, node) {
  return { ...env, PATH: [path.dirname(node), env.PATH].filter(Boolean).join(path.delimiter) }
}
