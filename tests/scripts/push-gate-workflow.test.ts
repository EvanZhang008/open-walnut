/**
 * The push gate's workflow (.github/workflows/push-gate.yml) runs what CI's blocking quick and
 * frontend legs run, and only for a gate branch. A new quick or frontend leg in ci.yml, or a
 * changed command, fails here until the gate runs it too; a tier the verdict does not count
 * fails here as well.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const gate = read('.github/workflows/push-gate.yml')
const ci = read('.github/workflows/ci.yml')

/** `tier: … cmd: …` pairs of a workflow's matrix entries whose tier is quick or frontend. */
function tiers(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^\s*- tier: (.+)\n\s*cmd: (.+)$/gm)) {
    const tier = m[1]!.trim()
    if (/^(quick|frontend)\b/.test(tier)) out.set(tier, m[2]!.trim())
  }
  return out
}

describe('push-gate.yml', () => {
  it('runs every quick and frontend leg of ci.yml, command for command', () => {
    const want = tiers(ci)
    expect(want.size).toBeGreaterThanOrEqual(4)
    expect([...tiers(gate)]).toEqual([...want])
  })

  it('runs only for a gate branch, never for main or a pull request', () => {
    expect(gate).toMatch(/^on:\n {2}push:\n {4}branches: \['gate\/\*\*'\]\n\n/m)
    expect(gate).not.toMatch(/pull_request/)
  })

  it('never fails its run for a failing test: the verdict is a status', () => {
    const testSteps = [...gate.matchAll(/id: tests\n((?: {8}.*\n)+)/g)].map((m) => m[1]!)
    expect(testSteps).toHaveLength(2)
    for (const s of testSteps) expect(s).toMatch(/continue-on-error: true/)
    expect(gate).toMatch(/statuses: write/)
  })

  it('writes one status per tier, as many as the verdict counts', () => {
    const counted = Number(read('scripts/push-gate-status.sh').match(/^TIERS=(\d+)/m)![1])
    const matrix = tiers(gate).size
    const browser = (gate.match(/CONTEXT: walnut\/push-gate \(browser specs\)/g) ?? []).length
    expect(gate).toMatch(/CONTEXT: walnut\/push-gate \(\$\{\{ matrix\.tier \}\}\)/)
    expect(matrix + browser).toBe(counted)
    // The verdict runs whatever the tiers did, except in a run a newer gate of the commit cancelled.
    expect(gate).toMatch(/needs: \[test, browser\]\n\s+if: \$\{\{ !cancelled\(\) \}\}/)
    expect(gate).not.toMatch(/if: always\(\)/)
  })
})
