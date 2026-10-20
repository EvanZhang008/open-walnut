/**
 * The Linux speech engine build (.github/workflows/stt-runtime.yml +
 * scripts/stt-runtime/build-llama.sh) fails only on a manual dispatch, so a
 * mistake in either shows up only there. Two shapes it must keep:
 *
 * - The startup check runs the binary alone inside each image. A minimal image
 *   has no tar (amazonlinux:2023, run 39473812166), and the check is whether
 *   the engine starts there, not whether the image can unpack it.
 * - No pipeline in the build script ends with a reader that stops early.
 *   Under pipefail, `awk '... {exit}'` leaves its writer to SIGPIPE and the
 *   step exits 141 (run 39471687596).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = path.resolve(__dirname, '../..')
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/stt-runtime.yml'), 'utf8'))
const buildScript = fs.readFileSync(path.join(root, 'scripts/stt-runtime/build-llama.sh'), 'utf8')

describe('stt-runtime workflow', () => {
  it('starts the engine in each image with no tool from the image', () => {
    const steps: Array<{ name?: string; run?: string }> = workflow.jobs.build.steps
    const check = steps.find((s) => /starts on/i.test(s.name ?? ''))
    expect(check?.run).toBeTruthy()
    const runs = check!.run!.split('\n').filter((l) => /docker run/.test(l))
    expect(runs.length).toBeGreaterThan(0)
    for (const line of runs) {
      expect(line).toMatch(/"\$img" \/r\/llama-server\/llama-server --version/)
      expect(line).not.toMatch(/\bsh -c\b|\btar\b/)
    }
  })

  it('build script uses pipefail and no early-exit reader in a pipe', () => {
    expect(buildScript).toMatch(/^set -euo pipefail$/m)
    const piped = buildScript.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.includes('|'))
    for (const line of piped) {
      expect(line, line).not.toMatch(/\|\s*awk\b[^|]*\bexit\b/)
      expect(line, line).not.toMatch(/\|\s*head\b/)
      expect(line, line).not.toMatch(/\|\s*grep\s+(-\w*q|-m\s*\d)/)
    }
  })
})
