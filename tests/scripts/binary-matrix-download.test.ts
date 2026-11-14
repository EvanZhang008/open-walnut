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
// The second download cannot hang: on 2026-11-11 (push run 43016273510, centos:7) both of
// actions/download-artifact's tries stalled on the blob for 8 minutes each. It is the
// workflow's FETCH_ARTIFACT, curl through the REST API, which gives up on a stalled stream
// and asks again.
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/binary-matrix.yml')
const RELEASE = path.resolve(__dirname, '../../.github/workflows/release.yml')
const doc = parseYaml(fs.readFileSync(WORKFLOW, 'utf8'))
const isFetch = (s: Step | undefined, name: string, dir: string) =>
  !!s && !s.uses && s.run === `sh -c "$FETCH_ARTIFACT" fetch ${name} ${dir}` && s.env?.GH_TOKEN === '${{ github.token }}'

type Step = { id?: string; uses?: string; if?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }
type Job = { env?: Record<string, string>; steps?: Step[]; permissions?: Record<string, string> }

const isFilesDownload = (s: Step) => !!s.uses?.startsWith('actions/download-artifact@') && s.with?.name === 'walnut-files'
// A release's assets (inputs.files): on 2026-11-07 this download hung on macos-26-intel
// until the job's 30 minutes ran out, which cancelled the 0.6.28 promotion.
const isReleaseDownload = (s: Step) => !!s.uses?.startsWith('actions/download-artifact@') && s.with?.name === '${{ inputs.files }}'

describe('binary matrix rows survive a download that fails or ends without the file', () => {
  const jobs = Object.entries<Job>(doc.jobs)
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
      expect(isFetch(again, 'walnut-files', 'dist-bin')).toBe(true)
      expect(again?.if).toContain("steps.files.outputs.missing == 'true'")
      // the fetch reads the artifact API with the job's token
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read' })
      expect(require?.run).toMatch(/\[ -s "dist-bin\/\$FILE" \] \|\| \{[^}]*exit 1/)
      expect(file(check)).toBeTruthy()
      expect(file(require)).toBe(file(check))
    })
  }

  for (const [name, job] of takers) {
    it(`${name}: a release's assets are cut off when the download hangs, checked, and downloaded again`, () => {
      const steps = job.steps!
      const first = steps.findIndex(isReleaseDownload)
      expect(first).toBeGreaterThan(0)
      const [check, again] = steps.slice(first + 1, first + 3)
      expect((steps[first] as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
      expect(check?.id).toBe('release')
      expect(check?.run).toContain('-s "$RUNNER_TEMP/release/SHA256SUMS"')
      expect(check?.run).toContain('walnut-$VERSION-${FILE#walnut-}.gz')
      expect(check?.run).toContain('missing=true')
      expect(check?.env?.FILE ?? job.env?.FILE).toBeTruthy()
      expect(isFetch(again, '"$NAME"', '"$RUNNER_TEMP/release"')).toBe(true)
      expect(again?.env?.NAME).toBe('${{ inputs.files }}')
      expect(again?.if).toContain("steps.release.outputs.missing == 'true'")
      // the unpack that reads them comes after both downloads
      const unpack = steps.findIndex((s) => !!s.run?.includes('release-unpack.sh'))
      expect(unpack).toBeGreaterThan(first + 2)
    })
  }

  it('the fetch gives up on a stalled stream, asks again three times, and needs no file of the checkout', () => {
    const fetch: string = doc.env.FETCH_ARTIFACT
    expect(fetch).toMatch(/--speed-limit \d+ --speed-time \d+/)
    expect(fetch).toMatch(/--max-time \d+/)
    expect(fetch).toContain('[ "$try" -lt 3 ] || exit 1')
    // the artifact id is asked for again on each try: a fresh signed link
    const loop = fetch.slice(fetch.indexOf('while :; do'), fetch.indexOf('done'))
    expect(loop).toContain('/artifacts?name=$name')
    expect(loop).toContain('$api/artifacts/$id/zip')
    // a release checks out an older `ref`: nothing here may come from the repository
    expect(fetch).not.toMatch(/scripts\/|\.github\//)
  })

  it('every release job that calls the matrix lets it read artifacts', () => {
    const release = parseYaml(fs.readFileSync(RELEASE, 'utf8'))
    const callers = Object.entries<{ uses?: string; permissions?: Record<string, string> }>(release.jobs)
      .filter(([, j]) => j.uses === './.github/workflows/binary-matrix.yml')
    expect(callers.length).toBeGreaterThanOrEqual(3)
    for (const [name, j] of callers) expect(j.permissions?.actions, name).toMatch(/^(read|write)$/)
  })
})
