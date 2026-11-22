/**
 * The Cloud companion tab says whether the companion takes this Mac ("Connected", "Not accepted")
 * on its Cloud sync row, and since 2026-11-21 that row sits in "Manage cloud companion", a fold
 * that is closed by default. Two browser specs kept reading the words straight off the card and
 * timed out on a hidden tag in the nightly run (cloud-host-other-mac, cloud-host-silent-link).
 *
 * The rule, enumerated from the source so a new state word is covered too: every spec that
 * expects one of the row's words to be visible reads it through `cloudSyncRow` (it opens the fold).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLOUD_SECTION = 'web/src/components/settings/sections/CloudSection.tsx'
const SPECS = 'tests/e2e/browser'

function stateWords(): string[] {
  const src = fs.readFileSync(path.join(ROOT, CLOUD_SECTION), 'utf8')
  const decl = src.match(/const connectedTag = [\s\S]*?;\n/)
  expect(decl, `${CLOUD_SECTION} no longer declares connectedTag: update this guard`).not.toBeNull()
  return [...decl![0].matchAll(/<SettingsTag[^>]*>([^<{]+)<\/SettingsTag>/g)].map((m) => m[1].trim())
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.ts$/.test(e.name) ? [p] : []
  })
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('the Cloud sync state is read through cloudSyncRow', () => {
  it('the state words come from the source, and the configured row is folded', () => {
    expect(stateWords()).toEqual(expect.arrayContaining(['Connected', 'Not accepted']))
    // The configured view's Cloud sync row is inside the fold; if it moves out, cloudSyncRow and
    // this guard move with it.
    const src = fs.readFileSync(path.join(ROOT, CLOUD_SECTION), 'utf8')
    const fold = src.indexOf('id="cloud-manage"')
    expect(fold).toBeGreaterThan(-1)
    expect(src.lastIndexOf('control={connectedTag}')).toBeGreaterThan(fold)
  })

  it('no spec expects a state word visible without opening the fold', () => {
    const words = stateWords()
    const read = new RegExp(`getByText\\((['"])(${words.map(escape).join('|')})\\1`)
    const offenders: string[] = []
    let reads = 0
    for (const file of walk(path.join(ROOT, SPECS))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!read.test(line) || !/\.toBeVisible\(/.test(line)) return
        reads++
        if (!line.includes('cloudSyncRow(')) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`)
      })
    }
    expect(offenders, 'read the state with (await cloudSyncRow(page)).getByText(...) from devices-ways-helpers').toEqual([])
    expect(reads).toBeGreaterThan(0)
  })
})
