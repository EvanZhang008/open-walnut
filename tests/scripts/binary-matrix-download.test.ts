import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

// actions/download-artifact can pass with the file missing when its connection is
// cut mid-stream: on 2026-10-28 the macos-26-intel row logged "Starting download"
// and nothing after, the step succeeded, and the job failed two steps later on
// "dist-bin/walnut-darwin-x64: No such file or directory". Every row that takes the
// built files therefore checks its file, downloads once more when it is missing,
// and fails naming the artifact when it is still missing.
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/binary-matrix.yml')

type Step = { id?: string; uses?: string; if?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }
type Job = { env?: Record<string, string>; steps?: Step[] }

const isFilesDownload = (s: Step) => !!s.uses?.startsWith('actions/download-artifact@') && s.with?.name === 'walnut-files'

describe('binary matrix rows survive a download that fails or ends without the file', () => {
  const jobs = Object.entries<Job>(parseYaml(fs.readFileSync(WORKFLOW, 'utf8')).jobs)
  const takers = jobs.filter(([, job]) => (job.steps ?? []).some(isFilesDownload))

  it('finds the rows that take the built files', () => {
    expect(takers.map(([name]) => name).sort()).toEqual(['linux', 'macos', 'old-kernel'])
  })

  for (const [name, job] of takers) {
    it(`${name}: checks the file, downloads again when it is missing, then requires it`, () => {
      const steps = job.steps!
      const first = steps.findIndex(isFilesDownload)
      const [check, again, require] = steps.slice(first + 1, first + 4)
      const file = (s: Step | undefined) => s?.env?.FILE ?? job.env?.FILE
      // A download that fails outright (the artifact service timed out, 2026-10-31)
      // must not end the job before the second download.
      expect((steps[first] as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
      expect(check?.id).toBe('files')
      expect(check?.run).toContain('-s "dist-bin/$FILE"')
      expect(check?.run).toContain('missing=true')
      expect(isFilesDownload(again!)).toBe(true)
      expect(again?.if).toContain("steps.files.outputs.missing == 'true'")
      expect(require?.run).toMatch(/\[ -s "dist-bin\/\$FILE" \] \|\| \{[^}]*exit 1/)
      expect(file(check)).toBeTruthy()
      expect(file(require)).toBe(file(check))
    })
  }
})
