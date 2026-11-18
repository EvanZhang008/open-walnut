/**
 * Class guard (2026-11-18, Walnut Health "Background errors keep happening"): a daemon update the
 * link cut while the new daemon was being put on the host changed nothing there and is tried again
 * on the next connection, so no remote update path may log it as a failure. Every file that runs
 * a remote daemon update (calls updateRemoteDaemonService) must say how it handles that stage
 * failure: stageCutByLink (the host network path) or its own postponement of DaemonUpdateStageError
 * (the SSH path). A new remote update path fails here until it does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageCutByLink } from '../../src/providers/daemon-update-readback.js'

const ROOT = path.resolve(__dirname, '../..', 'src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    return e.name.endsWith('.ts') ? [full] : []
  })
}

describe('a daemon update the link cut is never a failure', () => {
  it('every remote update path handles the stage failure a dropped link causes', () => {
    const callers = sourceFiles(ROOT)
      .filter((f) => !f.endsWith('daemon-service-update.ts'))
      .filter((f) => /\bupdateRemoteDaemonService\b/.test(fs.readFileSync(f, 'utf8')))
    expect(callers.length).toBeGreaterThanOrEqual(2)
    const unhandled = callers.filter((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return !text.includes('stageCutByLink(') && !text.includes("'DaemonUpdateStageError'")
    })
    expect(unhandled.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  it('stageCutByLink: only a stage failure with the link down', () => {
    const stage = Object.assign(new Error('Daemon update upload failed'), { name: 'DaemonUpdateStageError' })
    expect(stageCutByLink(stage, false)).toBe(true)
    expect(stageCutByLink(stage, true)).toBe(false)
    expect(stageCutByLink(new Error('Managed daemon update failed: busy'), false)).toBe(false)
    expect(stageCutByLink(null, false)).toBe(false)
  })
})
