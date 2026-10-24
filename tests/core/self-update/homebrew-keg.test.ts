/**
 * The `brew upgrade` line for a 0.6.x Homebrew keg whose Node archive updated
 * itself onto the npm launcher: offered only when Homebrew would act (the
 * formula is newer than the keg's own version) and would take nothing back
 * (the formula is not older than what the keg now runs).
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-homebrew-keg'))

import { brewUpgradeHint, formulaVersionForKeg, formulaVersionOf } from '../../../src/core/self-update/homebrew-keg.js'

const KEG = '/opt/homebrew/Cellar/open-walnut/0.6.17'
const TAP_RB = '/opt/homebrew/Library/Taps/evanzhang008/homebrew-tap/Formula/open-walnut.rb'
const rb = (version: string) => `class OpenWalnut < Formula\n  desc "Personal AI"\n  version "${version}"\n  license "MIT"\nend\n`

/** A fake disk: path -> content; anything else is ENOENT. */
function disk(files: Record<string, string>) {
  return {
    readFile: async (p: string) => {
      if (p in files) return files[p]!
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
  }
}

const receipt = (source: Record<string, unknown>) => JSON.stringify({ homebrew_version: '4.6.0', source })

describe('formulaVersionOf', () => {
  it('reads the formula\'s version line', () => {
    expect(formulaVersionOf(rb('0.7.0'))).toBe('0.7.0')
    expect(formulaVersionOf('class X < Formula\nend\n')).toBeNull()
  })
})

describe('formulaVersionForKeg', () => {
  it('reads the formula at the path the receipt recorded', async () => {
    const files = { [`${KEG}/INSTALL_RECEIPT.json`]: receipt({ path: TAP_RB, tap: 'evanzhang008/tap' }), [TAP_RB]: rb('0.7.0') }
    expect(await formulaVersionForKeg(KEG, disk(files))).toBe('0.7.0')
  })

  it('finds the tap the receipt names when its path moved (Apple silicon, Intel)', async () => {
    const arm = { [`${KEG}/INSTALL_RECEIPT.json`]: receipt({ tap: 'evanzhang008/tap' }), [TAP_RB]: rb('0.7.1') }
    expect(await formulaVersionForKeg(KEG, disk(arm))).toBe('0.7.1')
    const intelKeg = '/usr/local/Cellar/open-walnut/0.6.17'
    const intelRb = '/usr/local/Homebrew/Library/Taps/evanzhang008/homebrew-tap/Formula/open-walnut.rb'
    const intel = { [`${intelKeg}/INSTALL_RECEIPT.json`]: receipt({ path: '/gone/open-walnut.rb', tap: 'evanzhang008/tap' }), [intelRb]: rb('0.7.2') }
    expect(await formulaVersionForKeg(intelKeg, disk(intel))).toBe('0.7.2')
  })

  it('is null without a receipt or a readable formula', async () => {
    expect(await formulaVersionForKeg(KEG, disk({}))).toBeNull()
    expect(await formulaVersionForKeg(KEG, disk({ [`${KEG}/INSTALL_RECEIPT.json`]: 'not json' }))).toBeNull()
    expect(await formulaVersionForKeg(KEG, disk({ [`${KEG}/INSTALL_RECEIPT.json`]: receipt({ tap: 'evanzhang008/tap' }) }))).toBeNull()
  })
})

describe('brewUpgradeHint', () => {
  const files = (formula: string) => disk({ [`${KEG}/INSTALL_RECEIPT.json`]: receipt({ path: TAP_RB, tap: 'evanzhang008/tap' }), [TAP_RB]: rb(formula) })

  it('names brew upgrade when the formula is newer than the keg and not older than what it runs', async () => {
    const same = await brewUpgradeHint(KEG, '0.7.0', files('0.7.0'))
    expect(same).toMatchObject({ command: 'brew upgrade open-walnut', formula: '0.7.0' })
    expect(same!.note).toContain('it updates itself; brew upgrade open-walnut moves it to the compiled file (formula 0.7.0)')
    expect(await brewUpgradeHint(KEG, '0.6.99', files('0.7.0'))).toMatchObject({ formula: '0.7.0' })
  })

  it('stays quiet when brew would take the keg back to an older Walnut', async () => {
    // The keg updated itself past the formula (a tap not updated since, the nightly channel).
    expect(await brewUpgradeHint(KEG, '0.7.1', files('0.7.0'))).toBeNull()
    expect(await brewUpgradeHint(KEG, '0.7.1-nightly.20261101.3', files('0.7.0'))).toBeNull()
  })

  it('stays quiet when brew would do nothing (the formula is still the keg\'s own version) or nothing is known', async () => {
    expect(await brewUpgradeHint(KEG, '0.6.99', files('0.6.17'))).toBeNull()
    expect(await brewUpgradeHint(KEG, '0.6.99', disk({}))).toBeNull()
    expect(await brewUpgradeHint(null, '0.6.99', files('0.7.0'))).toBeNull()
  })
})
