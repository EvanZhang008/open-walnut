/**
 * No code path writes a config.yaml on a host replica (docs/plan/walnut-replica-servers-impl.md,
 * WP5): its config is the Mac's copy (core/replication/kinds/config.ts), and every
 * writer there answers needs_leader or does nothing. Most writers go through
 * core/config-store.ts (writeConfigWithBackup, which refuses on a replica); a
 * writer that touches the file directly bypassed that refusal once (the boot's
 * migrateConfigToPlugins). Reads src/ as text: every direct write of CONFIG_FILE,
 * its backup or a `config.yaml` path must sit in a function that checks for the
 * replica first. The guarded writers' behaviour is pinned by
 * tests/core/replication/kinds/config.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WRITE = /\b(writeFile|writeFileSync|writeFileAtomic|commitConfigFile|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync)\([^)]*(CONFIG_FILE|CONFIG_BACKUP_FILE|config\.yaml)/
const GUARD = /isHostReplicaProgram\(\)|refuseConfigWriteOnReplica\(\)/
const FUNCTION_START = /^(export\s+)?(async\s+)?function\s+\w+/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

interface Site { where: string; guarded: boolean }

function writeSites(): Site[] {
  const sites: Site[] = []
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line) || !WRITE.test(line)) return
      // The enclosing top-level function: from its first line down to the write.
      let start = i
      while (start > 0 && !FUNCTION_START.test(lines[start]!)) start--
      sites.push({ where: `${path.relative(ROOT, file)}:${i + 1}`, guarded: lines.slice(start, i + 1).some((l) => GUARD.test(l)) })
    })
  }
  return sites
}

describe('config.yaml writers on a host replica', () => {
  const sites = writeSites()

  it('the scan finds the writers it is known to (a scan that went blind would pass anything)', () => {
    const files = new Set(sites.map((s) => s.where.replace(/:\d+$/, '')))
    // Every writer goes through config-store.ts (integration-loader's boot migration too, via migrateStoredConfig).
    expect([...files].sort()).toEqual(['src/core/config-store.ts'])
    expect(sites.length).toBeGreaterThanOrEqual(3)
  })

  it('every direct write of the file sits behind a replica check', () => {
    const open = sites.filter((s) => !s.guarded).map((s) => s.where)
    expect(open, `guard these with isHostReplicaProgram() (a host replica writes no config.yaml):\n${open.join('\n')}`).toEqual([])
  })
})
