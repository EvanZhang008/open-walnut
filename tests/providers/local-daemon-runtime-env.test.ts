/**
 * A compiled-file server starts its local daemon as itself (`<file> __daemon`),
 * and the file unpacks its runtime tree before anything else runs. The daemon's
 * env drops OPEN_WALNUT_HOME, so without WALNUT_RUNTIME_DIR it would unpack into
 * the REAL data home (and prune other builds there) even when the server is a
 * deploy's smoke boot or a test server. buildSpawnEnv() hands it the server's own
 * tree; a server that is not the compiled file sets nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-local-daemon-runtime-env'))

import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { fileIdentity, setSingleFile } from '../../src/lib/single-file.js'

const KEY = '__WALNUT_SINGLE_FILE__'
const saved = process.env.WALNUT_RUNTIME_DIR

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEY]
  if (saved === undefined) delete process.env.WALNUT_RUNTIME_DIR
  else process.env.WALNUT_RUNTIME_DIR = saved
})

describe('the local daemon env and the compiled file runtime tree', () => {
  it('names the parent of the tree this server runs from', async () => {
    setSingleFile({ root: '/stage/open-walnut-stage.1.2/runtime/0.6.14-abcdefabcdef', daemonVersion: 'walnut-daemon-x', modules: {} })
    const env = await new LocalDaemon({ daemonDir: '/tmp/walnut-runtime-env-a' }).buildSpawnEnv()
    expect(env.WALNUT_RUNTIME_DIR).toBe('/stage/open-walnut-stage.1.2/runtime')
    expect(env.OPEN_WALNUT_HOME).toBeUndefined()
  })

  it('replaces an inherited value with this server tree', async () => {
    process.env.WALNUT_RUNTIME_DIR = '/old/stage/runtime'
    setSingleFile({ root: '/home/acme/.open-walnut/local/runtime/0.6.14-abcdefabcdef', daemonVersion: 'walnut-daemon-x', modules: {} })
    const env = await new LocalDaemon({ daemonDir: '/tmp/walnut-runtime-env-b' }).buildSpawnEnv()
    expect(env.WALNUT_RUNTIME_DIR).toBe('/home/acme/.open-walnut/local/runtime')
  })

  it('leaves the env alone for a server that is not the compiled file', async () => {
    delete process.env.WALNUT_RUNTIME_DIR
    const env = await new LocalDaemon({ daemonDir: '/tmp/walnut-runtime-env-c' }).buildSpawnEnv()
    expect(env.WALNUT_RUNTIME_DIR).toBeUndefined()
  })
})

describe('the daemon version a compiled server expects', () => {
  const expected = (d: LocalDaemon) => (d as unknown as { readBinaryVersion(p: string): string | null }).readBinaryVersion(process.execPath)

  it('is the version compiled into the file while the file on disk is the one it started from', () => {
    setSingleFile({ root: '/rt', daemonVersion: 'walnut-daemon-x', modules: {}, execId: fileIdentity(process.execPath) })
    expect(expected(new LocalDaemon({ daemonDir: '/tmp/walnut-runtime-env-d' }))).toBe('walnut-daemon-x')
  })

  it('is none once an update replaced the file: the daemon that runs is kept, not restarted into the same new file', () => {
    setSingleFile({ root: '/rt', daemonVersion: 'walnut-daemon-x', modules: {}, execId: '0:0' })
    expect(expected(new LocalDaemon({ daemonDir: '/tmp/walnut-runtime-env-e' }))).toBeNull()
  })
})
