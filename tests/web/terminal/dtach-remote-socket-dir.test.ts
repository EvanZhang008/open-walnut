/**
 * A second user on this machine keeps the local runtime dir under their home
 * (src/lib/daemon-dir.ts), and the local terminal sockets with it. That path
 * means nothing on a remote host, so remote terminals use
 * /tmp/open-walnut/term-<local uid> there: beside the first user's
 * /tmp/open-walnut/term, whose orphan sweep would end sockets it does not know.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/lib/daemon-dir.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/daemon-dir.js')>()
  return {
    ...actual,
    localDaemonDirChoice: () => ({ dir: '/home/second/.cache/open-walnut', explicit: false, fallback: true, reason: 'test' }),
  }
})

const REMOTE = `/tmp/open-walnut/term-${process.getuid?.() ?? 'user'}`
const {
  DTACH_SOCKET_DIR,
  REMOTE_DTACH_SOCKET_DIR,
  buildDtachArgs,
  buildRemoteDtachCommand,
  dtachOwnerClaimScript,
  dtachOwnerMarkerPath,
  dtachSocketPath,
} = await import('../../../src/web/terminal/spawn.js')

describe('remote terminal sockets for a home-dir fallback', () => {
  it('the remote socket dir is a per-user one beside the shared one, the local one stays local', () => {
    expect(REMOTE_DTACH_SOCKET_DIR).toBe(REMOTE)
    expect(REMOTE_DTACH_SOCKET_DIR).not.toBe('/tmp/open-walnut/term')
    expect(dtachSocketPath('sid1', true)).toBe(`${REMOTE}/walnut-sid1.dsock`)
    expect(dtachSocketPath('sid1')).toBe(`${DTACH_SOCKET_DIR}/walnut-sid1.dsock`)
    expect(dtachOwnerMarkerPath(true)).toBe(`${REMOTE}/.owner`)
    expect(dtachOwnerMarkerPath()).toBe(`${DTACH_SOCKET_DIR}/.owner`)
  })

  it('the ssh command makes and claims the remote dir, never the local path', () => {
    const cmd = buildRemoteDtachCommand('dtach', 'sid2')
    expect(cmd).toContain(dtachOwnerClaimScript(true))
    expect(cmd).toContain(`mkdir -p '${REMOTE}'`)
    expect(cmd).toContain(`-A '${REMOTE}/walnut-sid2.dsock'`)
    expect(cmd).not.toContain(DTACH_SOCKET_DIR)
  })

  it('a local terminal still uses the local dir', () => {
    expect(buildDtachArgs('/bin/dtach', 'sid3', '/bin/zsh')[2]).toBe(`${DTACH_SOCKET_DIR}/walnut-sid3.dsock`)
    expect(dtachOwnerClaimScript()).toContain(DTACH_SOCKET_DIR)
  })
})
