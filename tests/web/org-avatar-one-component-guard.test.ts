/**
 * Every avatar the Org page draws goes through OrgAvatar.tsx (NodeAvatar), so each node wears its
 * own character everywhere: before it, four places drew their own two-letter tile
 * (the list, the routers, a moved project; the head and the chart through the list's copy).
 * A new place that draws letters by itself (initials(...) or an `org-avatar` tile) fails here, and
 * so does one that works out a row's shown name without shownName.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ORG = path.resolve(import.meta.dirname, '../../web/src/components/org')
const ALLOWED = new Set(['OrgAvatar.tsx', 'org-channels-model.ts'])

describe('one Org avatar component', () => {
  it('no Org file but OrgAvatar.tsx draws a letter tile of its own', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(ORG)) {
      if (!/\.(tsx?|jsx?)$/.test(f) || ALLOWED.has(f)) continue
      const src = fs.readFileSync(path.join(ORG, f), 'utf8')
      if (/\binitials\(/.test(src) || /className=["'`]org-avatar[\s"'`]/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  // 2026-11-20: the avatar editor opened a renamed VP under its project's name, since it read
  // row.name where the list shows row.vpName ?? row.name. Every Org file reads the shown name
  // through shownName (org-channels-model.ts), so the two can never part again.
  it('no Org file works out the shown name of a row by itself', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(ORG)) {
      if (!/\.(tsx?|jsx?)$/.test(f) || f === 'org-channels-model.ts') continue
      if (/\.vpName \?\?/.test(fs.readFileSync(path.join(ORG, f), 'utf8'))) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
