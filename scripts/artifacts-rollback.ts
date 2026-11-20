#!/usr/bin/env bun
/**
 * Go back to a release before Walnut's artifacts folder was the only place for skills, memory
 * folders and each node's MEMORY.md (src/core/artifacts/rollback.ts says what it writes where).
 *
 * Usage, with Walnut stopped:
 *   bun scripts/artifacts-rollback.ts            # writes the old places back from the artifacts folder
 *   OPEN_WALNUT_HOME=/path bun scripts/artifacts-rollback.ts   # another Walnut home
 * Then start the older release. It refuses while a Walnut server answers on its port (--force skips the check).
 */
import { rollbackArtifacts } from '../src/core/artifacts/rollback.js'

const port = Number(process.env.WALNUT_PORT || process.env.PORT || 3456)
if (!process.argv.includes('--force')) {
  const up = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1_500) }).then(() => true, () => false)
  if (up) {
    console.error(`A Walnut server answers on port ${port}: stop it first, then run this again (it writes task rows the server holds).`)
    process.exit(1)
  }
}
const report = await rollbackArtifacts()
console.log(JSON.stringify(report, null, 2))
process.exit(0)
