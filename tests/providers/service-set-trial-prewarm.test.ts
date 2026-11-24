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
import { proofEnvFor } from '../../src/providers/daemon-boot-proof.js'
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
