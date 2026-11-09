/**
 * The push gate's workflow (.github/workflows/push-gate.yml) runs what CI's blocking quick and
 * frontend legs run (its plan's FULL_TIERS, scripts/push-gate-plan.mjs), and only for a gate
 * branch. A new quick or frontend leg in ci.yml, or a changed command, fails here until the gate
 * runs it too; a tier the verdict does not count fails here as well.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { FULL_TIERS } from '../../scripts/push-gate-plan.mjs'

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
    expect(FULL_TIERS.map((t: { tier: string; cmd: string }) => [t.tier, t.cmd])).toEqual([...want])
    // The test job's matrix is the plan's.
    expect(gate).toMatch(/include: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/)
    expect(gate).toMatch(/run: bun scripts\/push-gate-plan\.mjs\n/)
  })

  it('runs only for a gate: a dispatch naming its commit, or an older hook\'s gate branch; never for main or a pull request', () => {
    expect(gate).toMatch(/^on:\n {2}push:\n {4}branches: \['gate\/\*\*'\]\n {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n/m)
    expect(gate).not.toMatch(/pull_request/)
    // The hook finds its dispatched run by this title.
    expect(gate).toMatch(/^run-name: Push gate \$\{\{ inputs\.sha \|\| github\.ref_name \}\}$/m)
  })

  it('judges the dispatched commit, not main: every checkout and every status names it', () => {
    expect(gate).toMatch(/^ {2}GATE_SHA: \$\{\{ inputs\.sha \|\| github\.sha \}\}$/m)
    const checkouts = [...gate.matchAll(/- uses: actions\/checkout@v\d+\n((?: {8}.*\n)*)/g)].map((m) => m[1]!)
    expect(checkouts.length).toBeGreaterThanOrEqual(3)
    for (const c of checkouts) expect(c).toMatch(/ref: \$\{\{ env\.GATE_SHA \}\}/)
    expect(read('scripts/push-gate-status.sh')).toMatch(/sha=\$\{GATE_SHA:-\$GITHUB_SHA\}/)
    expect(gate).toMatch(/group: push-gate-\$\{\{ inputs\.sha \|\| github\.ref \}\}/)
  })

  it('never fails its run for a failing test: the verdict is a status', () => {
    const testSteps = [...gate.matchAll(/id: tests\n((?: {8}.*\n)+)/g)].map((m) => m[1]!)
    // the tier's tests and the browser specs; a land's frontend step is `id: frontend`
    expect(testSteps).toHaveLength(2)
    expect(gate).toMatch(/id: frontend\n\s+if: \$\{\{ matrix\.frontend \}\}\n\s+continue-on-error: true/)
    for (const s of testSteps) expect(s).toMatch(/continue-on-error: true/)
    expect(gate).toMatch(/statuses: write/)
  })

  it('writes one status per tier, as many as the verdict counts', () => {
    const counted = Number(read('scripts/push-gate-status.sh').match(/^TIERS=(\d+)/m)![1])
    const browser = (gate.match(/CONTEXT: walnut\/push-gate \(browser specs\)/g) ?? []).length
    expect(gate).toMatch(/CONTEXT: walnut\/push-gate \(\$\{\{ matrix\.tier \}\}\)/)
    expect(FULL_TIERS.length + browser).toBe(counted)
    // A land run writes the plan's count, which the verdict and push-gate.sh read.
    expect(gate).toMatch(/GATE_TIERS: \$\{\{ needs\.plan\.outputs\.tiers \}\}/)
    expect(gate).toMatch(/CONTEXT: walnut\/push-gate \(frontend\)/)
    // The verdict runs whatever the tiers did, except in a run a newer gate of the commit cancelled.
    expect(gate).toMatch(/needs: \[plan, test, browser\]\n\s+if: \$\{\{ !cancelled\(\) \}\}/)
    expect(gate).not.toMatch(/if: always\(\)/)
  })
})
