/**
 * A test that builds its days from the current date uses a zone with no daylight saving time.
 *
 * 2026-11-02: tests/e2e/health-e2e.test.ts seeded "last night" in America/New_York from
 * Date.now(), and on the morning after the clock went back that night ran an hour long:
 * asleepMin read 530 for 470, and its 24 hourly buckets did not fill the 25 hour day. Fixed
 * dates can pick a day away from a change; a date from now cannot, so its zone must have none.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const NOW_DAY = /\blocalDate\(\s*Date\.now\(\)[^,)]*,/
const ZONE = /['"]((?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_\/+-]+)['"]/g

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') testFiles(p, out) } else if (/\.(test|spec)\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

const offsetAt = (zone: string, iso: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(iso))
    .find((p) => p.type === 'timeZoneName')!.value
const hasDst = (zone: string): boolean => offsetAt(zone, '2026-01-15T12:00:00Z') !== offsetAt(zone, '2026-07-15T12:00:00Z')

const offenders = (files: Array<{ file: string; text: string }>): string[] => files
  .filter(({ text }) => NOW_DAY.test(text))
  .flatMap(({ file, text }) => [...text.matchAll(ZONE)].map((m) => m[1]).filter(hasDst).map((zone) => `${file}: ${zone}`))

describe('a test whose days come from now', () => {
  it('names only zones without daylight saving time', () => {
    const files = testFiles(ROOT).filter((f) => f !== __filename)
      .map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))
    expect(files.filter(({ text }) => NOW_DAY.test(text)).map(({ file }) => file)).toContain('e2e/health-e2e.test.ts')
    expect(offenders(files)).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const text = "const TZ = 'America/New_York'\nconst TODAY = localDate(Date.now(), TZ)"
    expect(offenders([{ file: 'x.test.ts', text }])).toEqual(['x.test.ts: America/New_York'])
    expect(offenders([{ file: 'x.test.ts', text: text.replace('America/New_York', 'America/Phoenix') }])).toEqual([])
    expect(offenders([{ file: 'x.test.ts', text: "const TZ = 'Europe/Berlin'\nconst day = localDate(Date.UTC(2026, 5, 1), TZ)" }])).toEqual([])
  })
})
