/**
 * The ratchets that scan the whole daemon runtime read daemonRuntimeText()
 * (tests/helpers/daemon-runtime-text.ts): daemon-standalone.ts plus its area modules, the code moved
 * out of createDaemonRuntime's body into create<Area>(deps) factories. A module moved out that the
 * helper does not find would drop out of every one of those ratchets without a failure.
 *
 * Holds: every create* factory the runtime imports from a './daemon-*.js' module is an area module
 * the helper finds (it imports './daemon-module-deps.js'), or one of the modules below that were never
 * in the runtime's body. Name a moved-out module daemon-<area>.ts and give it the shared deps types.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { daemonAreaModules } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../..')

/** daemon-* modules with a create* factory that were their own modules before the split; only ever delete from it. */
const NEVER_IN_THE_BODY = new Set([
  'src/providers/daemon-child-spawn.ts',
  'src/providers/daemon-command-drain.ts',
  'src/providers/daemon-core.ts',
  'src/providers/daemon-cron-metadata.ts',
  'src/providers/daemon-cron-runtime.ts',
  'src/providers/daemon-in-process-client.ts',
  'src/providers/daemon-runtime-timers.ts',
])

describe('every module moved out of the daemon runtime is seen by the whole-runtime ratchets', () => {
  it('each create* the runtime imports from a daemon-* module is an area module or was never in the body', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    const imported = new Set<string>()
    for (const m of src.matchAll(/^import \{([^}]*)\} from '\.\/(daemon-[a-z0-9-]+)\.js'/gm)) {
      const names = m[1]!.split(',').map((n) => n.trim())
      if (names.some((n) => /^create[A-Z]\w*/.test(n))) imported.add(`src/providers/${m[2]}.ts`)
    }
    const areas = new Set(daemonAreaModules())
    expect([...imported].filter((f) => !areas.has(f) && !NEVER_IN_THE_BODY.has(f)).sort()).toEqual([])
    // The list names only modules still imported, and none the helper already finds.
    expect([...NEVER_IN_THE_BODY].filter((f) => !imported.has(f) || areas.has(f))).toEqual([])
    expect(areas.size).toBeGreaterThanOrEqual(7)
  })
})
