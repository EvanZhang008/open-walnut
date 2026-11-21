/**
 * Where the in-process daemon's runtime code is looked for (daemonRuntimeCandidates in
 * in-process-daemon.ts): beside the module when run from source, the daemon build's runtime
 * bundle otherwise, the binaries dir first.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { daemonRuntimeCandidates } from '../../src/providers/in-process-daemon.js'

const url = (file: string) => pathToFileURL(file).href
const bundle = (dir: string) => path.join(dir, 'daemon-runtime', 'daemon-standalone.js')

describe('daemonRuntimeCandidates', () => {
  it('run from source, names daemon-standalone.ts beside the module only', () => {
    expect(daemonRuntimeCandidates(url('/repo/src/providers/in-process-daemon.ts'), '/anywhere/daemon-binaries'))
      .toEqual(['/repo/src/providers/daemon-standalone.ts'])
  })

  it('a built server names the runtime bundle under the binaries dir first, then dist/daemon-binaries', () => {
    // The server bundled into dist/cli.js: its daemon build is dist/daemon-binaries.
    expect(daemonRuntimeCandidates('file:///app/dist/cli.js', '/elsewhere/bin'))
      .toEqual([bundle('/elsewhere/bin'), bundle('/app/dist/daemon-binaries'), bundle('/app/daemon-binaries')])
    // A module one folder inside dist: dist/daemon-binaries is the folder above it.
    expect(daemonRuntimeCandidates('file:///opt/walnut/dist/providers/in-process-daemon.js', '/data/bin'))
      .toEqual([bundle('/data/bin'), bundle('/opt/walnut/dist/providers/daemon-binaries'), bundle('/opt/walnut/dist/daemon-binaries')])
  })

  it('names each place once, the binaries dir first', () => {
    expect(daemonRuntimeCandidates('file:///app/dist/cli.js', '/app/dist/daemon-binaries'))
      .toEqual([bundle('/app/dist/daemon-binaries'), bundle('/app/daemon-binaries')])
    expect(daemonRuntimeCandidates('file:///app/dist/providers/in-process-daemon.js', '/app/dist/daemon-binaries'))
      .toEqual([bundle('/app/dist/daemon-binaries'), bundle('/app/dist/providers/daemon-binaries')])
  })
})
