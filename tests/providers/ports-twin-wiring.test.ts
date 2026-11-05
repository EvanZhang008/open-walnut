/**
 * 'ports-v1' (port-scan-core.ts) is wired the same way in both daemon twins: each
 * dispatches ports.list and ports.stop, the source twin loads the sidecar and advertises
 * the capability only when it loaded, every deploy path ships the sidecar, the version
 * hash covers the module (or hosts never upgrade to it), and neither twin lets the cloud
 * bridge or a follower socket ask (ports.stop signals host processes).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('ports-v1 wiring', () => {
  const standalone = read('src/providers/daemon-standalone.ts')
  const source = read('src/providers/daemon-source.ts')

  it('both twins dispatch both commands', () => {
    for (const cmd of ['ports.list', 'ports.stop']) {
      expect(standalone).toContain(`case '${cmd}'`)
      expect(source).toContain(`case '${cmd}'`)
    }
  })

  it('the source twin loads the sidecar and gates the capability on it', () => {
    expect(source).toContain("require(path.join(__dirname, 'port-scan-core.cjs'))")
    expect(source).toContain("if (daemonPorts) caps.push('ports-v1')")
    expect(source).toMatch(/SIDECAR_GATED_CAPABILITIES = new Set\(\[[^\]]*'ports-v1'/)
  })

  it('every deploy path ships the sidecar, the build makes it, and the version covers it', () => {
    expect(read('src/providers/daemon-connection.ts')).toContain("'port-scan-core.cjs'")
    expect(read('src/providers/local-daemon.ts')).toContain("'port-scan-core.cjs'")
    const build = read('scripts/build-daemon.sh')
    expect(build).toContain('--outfile "$OUTDIR/port-scan-core.cjs"')
    expect(build).toContain('  src/providers/port-scan-core.ts\n')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/port-scan-core.ts'")
  })

  it('neither the bridge nor a follower may ask', () => {
    const lists = [
      /BRIDGE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(standalone)?.[1] ?? '',
      /BRIDGE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '',
      read('src/providers/follower-reads-core.ts'),
    ]
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      expect(list).not.toContain('ports.')
    }
  })
})
