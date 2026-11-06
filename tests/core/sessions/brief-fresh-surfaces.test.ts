/**
 * Guard: every surface that shows a Brief's letter also shows how current it is (2026-10-31, the
 * user on a VP's Brief 3.5 hours old: "明显的感觉现在已经不是 up to date了"). The letter's words are
 * only as new as the node's last turn, so a surface that prints them must mark what moved since
 * (src/core/sessions/brief-fresh.ts briefFreshness) and the refresh on its way (briefUpdating).
 *
 * Counted from the source: a web file that reads `brief.text` / `brief?.text` and a Swift file that
 * decodes a Brief's text are listed below, each either reading the freshness or named with the
 * reason it shows no letter. A new one fails here until it does one or the other.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}

/** Files that read the letter's text without showing it as a letter. */
const NOT_A_LETTER: Record<string, string> = {
  'web/src/hooks/task-list-merge.ts': 'compares two task rows to tell an update, shows nothing',
  'web/src/components/org/OrgTaskRail.tsx': 'only asks whether a letter exists, for the Fold button; OrgBrief draws it',
}

/** Swift files the phone matcher reads that show no letter. */
const PHONE_NOT_A_LETTER: Record<string, string> = {
  'ios-native/Walnut/Views/Org/OrgNodePage.swift': 'names the Brief page and its icon ("doc.text"); OrgBriefView draws the letter',
}

describe('every surface that shows a Brief reads its freshness', () => {
  it('web', () => {
    const readers = walk(join(ROOT, 'web/src'), /\.(ts|tsx)$/)
      .filter((f) => /\bbrief\??\.text\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
    expect(readers).toContain('web/src/components/org/OrgBrief.tsx')
    for (const f of readers) {
      if (NOT_A_LETTER[f]) continue
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(/\bfresh\b|briefFreshness/.test(src) && /updating|briefUpdating/.test(src), `${f} shows a Brief: read its freshness (brief-fresh.ts) or list it in NOT_A_LETTER`).toBe(true)
    }
  })

  it('phone', () => {
    // An Org node's Brief page on the phone (OrgBriefView.swift, 0801ce003) draws the letter, so it
    // reads the freshness; any other file that decodes the letter's text must read it too.
    const readers = walk(join(ROOT, 'ios-native'), /\.swift$/)
      .filter((f) => /\bbrief\b[^\n]*\btext\b|\bTaskBrief\b|\bbriefText\b/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
    expect(readers).toContain('ios-native/Walnut/Views/Org/OrgBriefView.swift')
    for (const f of readers) {
      if (PHONE_NOT_A_LETTER[f]) continue
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(/fresh/i.test(src), `${f} shows a Brief: mark what moved since it was written (brief-fresh.ts)`).toBe(true)
    }
  })
})
