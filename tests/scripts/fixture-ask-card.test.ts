/**
 * The browser specs that run only in Nightly extra tests put Needs you reports on their fixture
 * tasks through the real report door, which judges an agent's ask as it judges a worker's
 * (src/core/sessions/report-set.ts, userKindVerdict). 2026-11-23 (Nightly extra tests run
 * 45162939087): the door began refusing a card too thin to decide on, and
 * board-kanban-text-source's "<doc>:2 first" was refused, though no gate before the nightly runs
 * these specs. So each needs ask in those specs, with what setReport adds (FIXTURE_ASK), is judged
 * here by the door's own verdict, in the quick tier, and a spec that writes a report some other way
 * fails until it goes through setReport.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { userKindVerdict } from '../../src/core/org/user-kind.js'
import { FIXTURE_ASK } from '../e2e/browser/fixture-ask.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const BROWSER = 'tests/e2e/browser'

/** Every spec file Nightly extra tests runs: named on its own line, or by a config's testMatch. */
function nightlySpecs(): string[] {
  const yml = fs.readFileSync(path.join(REPO, '.github/workflows/nightly-extra-tests.yml'), 'utf8')
  const specs = new Set<string>()
  for (const m of yml.matchAll(/playwright test (?:-c (\S+\.config\.ts)|(\S+\.spec\.ts))/g)) {
    if (m[2]) { specs.add(m[2]); continue }
    const config = fs.readFileSync(path.join(REPO, m[1]!), 'utf8')
    const match = config.match(/^\s*testMatch:\s*(\[[^\]]*\]|'[^']+'|"[^"]+")/m)
    for (const x of match ? match[1]!.matchAll(/['"]([^'"]+)['"]/g) : []) specs.add(path.join(BROWSER, x[1]!))
    // agent-text.config.ts reads its names from a list in its own text (side-config-specs.ts).
    for (const x of config.matchAll(/['"]([\w-]+\.spec\.ts)['"]/g)) specs.add(path.join(BROWSER, x[1]!))
  }
  return [...specs].filter((f) => fs.existsSync(path.join(REPO, f)))
}

/** The asks a spec puts on a Needs you, with each `${...}` read as a short file path. */
function needsAsks(src: string): string[] {
  const asks: string[] = []
  const lit = (s: string) => s.replace(/\$\{[^}]*\}/g, 'docs/a.md')
  for (const m of src.matchAll(/state: 'needs', ask: `([^`]*)`/g)) asks.push(lit(m[1]!))
  for (const m of src.matchAll(/\bneeds\(`([^`]*)`\)/g)) asks.push(lit(m[1]!))
  return asks
}

describe('the nightly specs\' Needs you reports pass the report door', () => {
  const specs = nightlySpecs()

  it('finds the nightly specs, the agent-text ones among them', () => {
    expect(specs).toContain(`${BROWSER}/board-kanban-text-source.spec.ts`)
    expect(specs).toContain(`${BROWSER}/agent-status-source.spec.ts`)
  })

  it('setReport adds FIXTURE_ASK to every needs report', () => {
    const helper = fs.readFileSync(path.join(REPO, BROWSER, 'agent-text-entry-helpers.ts'), 'utf8')
    expect(helper).toMatch(/body\.state === 'needs'\s*\?\s*\{ \.\.\.FIXTURE_ASK, \.\.\.body \}/)
  })

  it('every needs ask, with FIXTURE_ASK, is one the door takes', () => {
    const judged: string[] = []
    const refused: string[] = []
    for (const f of specs) {
      for (const ask of needsAsks(fs.readFileSync(path.join(REPO, f), 'utf8'))) {
        judged.push(ask)
        // As report-set.ts asks it: the ask is the subject, ask_more the detail, no choices here.
        const v = userKindVerdict({ ...FIXTURE_ASK, subject: ask, detail: FIXTURE_ASK.ask_more, labels: [], choices: [] })
        if (!v.ok) refused.push(`${f}: "${ask}": ${v.message.slice(0, 120)}`)
      }
    }
    expect(judged.length).toBeGreaterThan(5)
    expect(refused).toEqual([])
  })

  it('the thin card the door refused is taken with FIXTURE_ASK, and refused without it', () => {
    const ask = 'docs/a.md:2 first'
    expect(userKindVerdict({ user_kind: FIXTURE_ASK.user_kind, user_kind_why: FIXTURE_ASK.user_kind_why, subject: ask, detail: '', labels: [], choices: [] }).ok).toBe(false)
    expect(userKindVerdict({ ...FIXTURE_ASK, subject: ask, detail: FIXTURE_ASK.ask_more, labels: [], choices: [] }).ok).toBe(true)
  })

  it('no nightly spec writes a report but through setReport', () => {
    const direct = specs.filter((f) => /\/report[`'"]/.test(fs.readFileSync(path.join(REPO, f), 'utf8')))
    expect(direct).toEqual([])
  })
})
