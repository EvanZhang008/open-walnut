/**
 * 'ports-v1' (port-scan-core.ts) is wired into the daemon: it dispatches ports.list and
 * ports.stop, the version hash covers the module (or hosts never upgrade to it), and it
 * never lets the cloud bridge or a follower socket ask (ports.stop signals host processes).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { daemonCommandNames } from '../helpers/daemon-runtime-text.js'

const root = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('ports-v1 wiring', () => {
  const standalone = read('src/providers/daemon-standalone.ts')

  it('the daemon dispatches both commands', () => {
    for (const cmd of ['ports.list', 'ports.stop']) expect(daemonCommandNames()).toContain(cmd)
  })

  it('the version covers the module', () => {
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/port-scan-core.ts'")
  })

  it('neither the bridge nor a follower may ask', () => {
    const lists = [
      /BRIDGE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(standalone)?.[1] ?? '',
      read('src/providers/follower-reads-core.ts'),
    ]
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      expect(list).not.toContain('ports.')
    }
  })
})
