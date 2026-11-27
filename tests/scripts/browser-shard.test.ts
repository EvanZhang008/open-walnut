/**
 * The browser legs' split (scripts/ci/browser-shard.mjs): every spec file runs in exactly one
 * leg, the one-at-a-time groups are spread over legs instead of filling one, and with the
 * measured times every leg ends inside its budget (2026-11-27, run 45945821701: Playwright's
 * --shard put all 195 host fixture tests in leg 16 on one worker, and legs 1, 6 and 16 ran out
 * of their 45 minutes with 270 tests never run).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { assign, DURATIONS_FILE, fileFilter, serialGroup, WORKERS } from '../../scripts/ci/browser-shard.mjs'

const BROWSER_DIR = path.join(__dirname, '..', 'e2e', 'browser')
/** The browser legs in ci.yml, and the test budget each has (its --global-timeout: 45 min). */
const LEGS = 16
const BUDGET_S = 45 * 60

describe('the browser legs split spec files by their time', () => {
  it('puts every file in exactly one leg, the same way on every leg', () => {
    const files = Array.from({ length: 300 }, (_, k) => ({ file: `s${k}.spec.ts`, tests: 1 + (k % 7), group: k % 9 === 0 ? 'host-fixture' : null }))
    const a = assign(files, {}, LEGS)
    const b = assign([...files].reverse(), {}, LEGS)
    expect(a).toEqual(b)
    const all = a.flatMap((s) => s.files)
    expect(all.sort()).toEqual(files.map((f) => f.file).sort())
  })

  it('spreads a one-at-a-time group over legs instead of filling one', () => {
    // The 2026-11-27 shape: 40 host fixture files of 45 min in all, beside 300 parallel files.
    const host = Array.from({ length: 40 }, (_, k) => ({ file: `host-${k}.spec.ts`, tests: 5, group: 'host-fixture' }))
    const rest = Array.from({ length: 300 }, (_, k) => ({ file: `p-${k}.spec.ts`, tests: 15, group: null }))
    const durations = Object.fromEntries([...host.map((f) => [f.file, 67]), ...rest.map((f) => [f.file, 400])])
    const shards = assign([...host, ...rest], durations, LEGS)
    const chains = shards.map((s) => s.chains['host-fixture'] ?? 0)
    expect(Math.max(...chains)).toBeLessThan(10 * 60)
    expect(chains.filter((c) => c > 0).length).toBeGreaterThan(4)
    const ideal = (40 * 67 + 300 * 400) / (LEGS * WORKERS)
    expect(Math.max(...shards.map((s) => s.seconds))).toBeLessThan(ideal * 1.15)
  })

  it('with the measured times and the specs as they are, every leg ends inside its budget', () => {
    const durations = JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8')) as Record<string, number>
    const specs = fs.readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.spec.ts'))
    const files = specs.map((file) => ({ file, tests: 1, group: serialGroup(fs.readFileSync(path.join(BROWSER_DIR, file), 'utf8')) }))
    const measured = files.filter((f) => durations[f.file] > 0)
    expect(measured.length).toBeGreaterThan(specs.length * 0.8)
    const shards = assign(measured, durations, LEGS)
    const over = shards.map((s, k) => ({ leg: k + 1, minutes: Math.round(s.seconds / 60) })).filter((s) => s.minutes * 60 > BUDGET_S * 0.8)
    // Over 80% of the budget: add legs (ci.yml) or make the slowest specs faster.
    expect(over).toEqual([])
  })

  it('names one file per filter, never another file ending in its name', () => {
    const re = (f: string) => { const m = f.match(/^\/(.*)\/$/)!; return new RegExp(m[1]) }
    const board = re(fileFilter('board.spec.ts'))
    expect(board.test('/w/open-walnut/tests/e2e/browser/board.spec.ts')).toBe(true)
    expect(board.test('/w/open-walnut/tests/e2e/browser/my-board.spec.ts')).toBe(false)
    expect(board.test('/w/open-walnut/tests/e2e/browser/boardXspec.ts')).toBe(false)
  })

  it('reads the one-at-a-time groups as the config does', () => {
    expect(serialGroup("await loadFixture(page, 'x')")).toBe('host-fixture')
    expect(serialGroup('const t = await useServerTunnel(page)')).toBe('sign-in')
    expect(serialGroup("test('plain', async () => {})")).toBe(null)
  })
})
