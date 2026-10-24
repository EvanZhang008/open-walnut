/**
 * What the daemon's JS twin (daemon-source.cjs) runs on in the twin suites.
 *
 * A host without the compiled daemon runs that file on its own Node, so the
 * suites run it on the real Node when the machine has one (not the shim
 * `bun --bun` puts first on PATH), and on this runner's bun when it has none,
 * as in the Node-free CI jobs. CI's node-side job runs the source twins with
 * WALNUT_REQUIRE_NODE=1 (`bun run test:source-twin-node`), where a missing Node
 * fails instead of falling back to bun.
 */
import { realNodeOnPath } from '../../scripts/outside-node.mjs'

export interface SourceTwinRuntime {
  runtime: 'node' | 'bun'
  file: string
}

export function sourceTwinRuntime(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): SourceTwinRuntime {
  const node = realNodeOnPath(env)
  if (node) return { runtime: 'node', file: node }
  if (env.WALNUT_REQUIRE_NODE === '1') {
    throw new Error('WALNUT_REQUIRE_NODE=1, and there is no Node on PATH: the source twin is checked on the Node a host runs it on')
  }
  return { runtime: 'bun', file: execPath }
}

/** This run's source twin runtime. */
export const SOURCE_TWIN = sourceTwinRuntime()
