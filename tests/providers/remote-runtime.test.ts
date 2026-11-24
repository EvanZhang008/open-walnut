/**
 * What counts as "the daemon file cannot RUN on this host" (remote-runtime.ts
 * isRuntimeStartFailure). The remote daemon is always the compiled one (a daemon
 * binary or the Walnut file), so this is the one check left of the old runtime
 * chain: a failure of this shape is reported as a host that cannot run it, while
 * a port clash or a key problem is not.
 */
import { describe, it, expect } from 'vitest'
import { isRuntimeStartFailure } from '../../src/providers/remote-runtime.js'

describe('runtime-shaped start failures', () => {
  it.each([
    'nohup: failed to run command \'/tmp/open-walnut/daemon-linux-x64\': Exec format error',
    '/tmp/open-walnut/daemon-linux-x64: /lib64/libc.so.6: version `GLIBC_2.27\' not found (required by daemon)',
    'sh: line 1: 70592 Illegal instruction: 4  nohup /x/daemon-linux-x64 --start',
    'Startup log: walnut-daemon-exit=132',
    'Startup log: walnut-daemon-exit=126',
    'Startup log: walnut-daemon-exit=127',
    '/tmp/open-walnut/daemon-linux-x64: cannot execute binary file',
  ])('runtime-shaped: %s', (text) => {
    expect(isRuntimeStartFailure(text)).toBe(true)
  })

  it.each([
    "daemon failed to start (port='', status='') Startup log: Error: listen EADDRINUSE",
    'Startup log: walnut-daemon-exit=1',
    'Permission denied (publickey).',
  ])('not runtime-shaped: %s', (text) => {
    expect(isRuntimeStartFailure(text)).toBe(false)
  })
})
