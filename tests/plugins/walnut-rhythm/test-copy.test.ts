/**
 * A test copy of Walnut reads the Mac but never changes it by itself (2026-11-01: a test
 * copy started during the person's own focus block took that block's Do Not Disturb as its
 * own and would have turned it off at the copied block's end).
 */
import { describe, expect, it } from 'vitest'
import { REAL_MAC_ENV, testCopyReason } from '../../../plugin-store/walnut-rhythm/src/server/test-copy'

const TMP = ['/tmp', '/var/folders/xy/T']
const ME = { accountHome: '/Users/me' }

describe('testCopyReason', () => {
  it('the real Walnut, its data in the home folder, changes the Mac', () => {
    expect(testCopyReason({ dataDir: '/Users/me/.open-walnut/plugin-data/walnut-rhythm', argv: ['walnut', 'web'], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).toBeNull()
  })

  it('an ephemeral server, a test run, or data in the temp folder leaves it alone', () => {
    expect(testCopyReason({ dataDir: '/Users/me/.open-walnut/x', argv: ['walnut', 'web', '--_ephemeral-child'], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).toBe('an ephemeral test server')
    expect(testCopyReason({ dataDir: '/Users/me/.open-walnut/x', argv: [], env: { VITEST: 'true' }, tmpRoots: TMP, ...ME })).toBe('a test run')
    expect(testCopyReason({ dataDir: '/var/folders/xy/T/open-walnut-1/plugin-data/walnut-rhythm', argv: [], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).toBe('a Walnut with its data in the temp folder')
    expect(testCopyReason({ dataDir: '/tmp/rh/home/plugin-data/walnut-rhythm', argv: [], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).not.toBeNull()
    // A folder whose name only starts like the temp folder is not inside it.
    expect(testCopyReason({ dataDir: '/tmpdata/walnut', argv: [], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).toBeNull()
  })

  it('a Walnut in a task folder, or with a stand-in HOME, is a test copy too', () => {
    expect(testCopyReason({ dataDir: '/Users/me/.local/state/open-walnut/tasks/abc/rh/home', argv: [], env: { HOME: '/Users/me' }, tmpRoots: TMP, ...ME })).toBe('a Walnut with its data in a task folder')
    expect(testCopyReason({ dataDir: '/work/state/open-walnut/tasks/abc/home', argv: [], env: { HOME: '/Users/me', XDG_STATE_HOME: '/work/state' }, tmpRoots: TMP, ...ME })).toBe('a Walnut with its data in a task folder')
    expect(testCopyReason({ dataDir: '/srv/x/home', argv: [], env: { HOME: '/srv/x', WALNUT_TASK_DIR: '/srv/x' }, tmpRoots: TMP, ...ME })).toBe('a Walnut with its data in a task folder')
    expect(testCopyReason({ dataDir: '/srv/fake/.open-walnut', argv: [], env: { HOME: '/srv/fake' }, tmpRoots: TMP, ...ME })).toBe('a Walnut with a stand-in home folder')
  })

  it(`a test that drives the Mac on purpose sets ${REAL_MAC_ENV}=1`, () => {
    expect(testCopyReason({ dataDir: '/tmp/x', argv: ['--_ephemeral-child'], env: { [REAL_MAC_ENV]: '1', VITEST: 'true' }, tmpRoots: TMP })).toBeNull()
  })
})
