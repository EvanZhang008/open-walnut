/**
 * A service set's install or update proves the new version with the set's own runtime place, so the
 * trial unpacks the walnut file's tree where the set's service will look for it.
 *
 * Review of the 2026-11-24 drill fixes (S4): the trial ran the staged walnut file on the CLI's own
 * tree (trialRuntimeDir), and the set's service then unpacked the same build again in
 * `<install root>/runtime` on its first start, inside the 60 s ready wait. The set's trial now
 * names that dir (proofEnvFor), so the service finds the tree whole. The default set's trial is
 * as it was.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { proofEnvFor, trialRuntimeDir } from '../../src/providers/daemon-boot-proof.js'
import { walnutLineRuntimeDir } from '../../src/binary/runtime-tree.js'
import { serviceSet } from '../../src/providers/service-set.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/home/walnut'
const ID = '0123456789abcdef'

describe('a set\'s trial prewarms the set\'s runtime trees', () => {
  it('a set\'s proof names <install root>/runtime; the default set\'s names nothing', () => {
    const set = serviceSet('linux', HOME, ID, { uid: 1000 })
    expect(proofEnvFor(set, set.installRoot)).toEqual({ WALNUT_RUNTIME_DIR: `${set.installRoot}/runtime` })
    const def = serviceSet('linux', HOME, '', { runtimeDir: '/tmp/open-walnut' })
    expect(proofEnvFor(def, def.installRoot)).toEqual({})
  })

  it('`walnut daemon install|update` gives its boot proof that env', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-service-cli.ts'), 'utf8')
    const at = cli.indexOf('return proveStagedBoot({')
    expect(at).toBeGreaterThan(-1)
    expect(cli.slice(at, at + 400)).toMatch(/env: proofEnvFor\(set, root\)/)
  })
})

describe('the default set\'s trial unpacks where the default service looks', () => {
  // 2026-11-24 review (S-c): an update run as a `--walnut` line, or from a set's session, runs
  // the CLI on a tree outside the data home; the default set's trial used that tree's dir, and
  // the default service then unpacked the same build in the data home inside its ready wait.
  const DATA = `${HOME}/.open-walnut/local/runtime`
  const setTrees = `${HOME}/.open-walnut-host/walnuts/${ID}/daemon/runtime`

  it.each([
    ['a --walnut line\'s tree', {}, path.join(walnutLineRuntimeDir(), '1.2.3-abc')],
    ['a set\'s tree', {}, `${setTrees}/1.2.3-abc`],
    ['a set session\'s runtime dir', { WALNUT_RUNTIME_DIR: setTrees }, null],
    ['a set session\'s runtime dir and tree', { WALNUT_RUNTIME_DIR: setTrees }, `${setTrees}/1.2.3-abc`],
  ])('from %s: the data home\'s', (_label, env, own) => {
    expect(trialRuntimeDir(env, HOME, own)).toBe(DATA)
  })

  it('from the data home\'s tree or a deploy stage: as before', () => {
    expect(trialRuntimeDir({}, HOME, `${DATA}/1.2.3-abc`)).toBe(DATA)
    expect(trialRuntimeDir({ WALNUT_RUNTIME_DIR: '/stage/runtime' }, HOME, '/stage/runtime/1.2.3-abc')).toBe('/stage/runtime')
    expect(trialRuntimeDir({ WALNUT_RUNTIME_DIR: '/stage/runtime' }, HOME, null)).toBe('/stage/runtime')
  })
})
