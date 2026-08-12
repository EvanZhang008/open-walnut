import { describe, expect, it } from 'vitest'
import { getLocalDaemonBinaryName } from '../../src/providers/local-daemon.js'

describe('getLocalDaemonBinaryName', () => {
  it('selects the Linux x64 daemon built by CI', () => {
    expect(getLocalDaemonBinaryName('linux', 'x64')).toBe('daemon-linux-x64')
  })

  it('selects the native daemon by default', () => {
    expect(getLocalDaemonBinaryName()).toBe(`daemon-${process.platform}-${process.arch}`)
  })
})
