/**
 * The cloud backup never uploads the Apple Health store: health/ is excluded
 * from the raw scan AND from the sqlite snapshot pass (findCanonicalSqlite would
 * otherwise pick up health.sqlite as "canonical data" and snapshot it to S3).
 * A note folder called health inside notes/ is ordinary user content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EXCLUDED_DIRS, findCanonicalSqlite, isExcluded, scanDataDir } from '../../../src/core/backup/scan.js'

let root: string

beforeEach(async () => {
  root = path.join(os.tmpdir(), `walnut-backup-health-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fsp.mkdir(root, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
})

const write = async (rel: string, content = 'x'): Promise<void> => {
  const abs = path.join(root, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
}

describe('backup excludes the Apple Health store', () => {
  it('health/ is an excluded directory for every file in it', () => {
    expect(EXCLUDED_DIRS.has('health')).toBe(true)
    for (const rel of ['health/health.sqlite', 'health/health.sqlite-wal', 'health/health.sqlite-shm']) {
      expect(isExcluded(rel), rel).toBe(true)
    }
    expect(isExcluded('notes/life/health/checkup.md')).toBe(false)
  })

  it('neither the raw scan nor the sqlite snapshot pass picks it up', async () => {
    await write('health/health.sqlite')
    await write('health/health.sqlite-wal')
    await write('sessions.sqlite')
    await write('notes/life/health/checkup.md')
    expect(await findCanonicalSqlite(root)).toEqual(['sessions.sqlite'])
    const scanned = (await scanDataDir(root)).map((e) => e.path)
    expect(scanned).toContain('notes/life/health/checkup.md')
    expect(scanned.some((p) => p.startsWith('health/'))).toBe(false)
  })
})
