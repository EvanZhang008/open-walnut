/**
 * The replica cluster (tests/helpers/replica-cluster.ts) replaces the Mac's upload to the host
 * only for a cluster that hosts a plugin (its job's code goes to the host daemon's dir): every
 * other cluster keeps the real upload path, so its cases still prove that path.
 */
import { describe, expect, it } from 'vitest'
import { macBoot } from '../helpers/replica-cluster.js'

const base = { macData: '/tmp/marina-mac', daemonPort: 4100, macCwd: '/tmp/marina-mac-work', hostCwd: '/tmp/marina-host-work', dev: true, hostDaemon: '/tmp' }

describe('the cluster\'s upload override', () => {
  it('is installed for a cluster with a plugin only', () => {
    expect(macBoot({ ...base, plugin: false })).not.toContain('prototype.uploadFile')
    const withPlugin = macBoot({ ...base, plugin: true })
    expect(withPlugin).toContain('dcm.DaemonConnection.prototype.uploadFile = async function')
    // Still only for devbox, only into the host daemon dir, checked by its sha256.
    expect(withPlugin).toContain('the test transport writes only into the host daemon dir')
    expect(withPlugin).toContain('uploadFile: sha256 does not match the data')
  })
})
