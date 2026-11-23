/**
 * A class written beside `btn` never sets what the family's `.btn` rule sets with a selector of the same
 * strength (one class): the two tie, and whichever stylesheet loads last wins. 2026-11-23: a phone's
 * 44 px finger size on `.phone-confirm-sheet-btn` and `.phone-tier-empty-btn` lost to the family's 34 px
 * (main's phone specs C58 and N22). Write the size as `.btn.my-key` (or under a scope) so it outranks the
 * family in any load order. The members come from the source: every class the TSX writes next to `btn`,
 * and every size the family's own `.btn` rule declares (its look, a fill or a colour, is the UI standard
 * ratchet's restyledBtn; layout such as gap or flex is free).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { btnCompanions, pluginStyles } from './ui-standard-scan'
import { scanCss, walk } from './css-scan'

const WEB = path.join(__dirname, '..', '..', 'web', 'src')
const FAMILY = 'styles/buttons.css'

const SIZE = /^(min-height|height|min-width|width|padding(-[a-z]+)?|line-height|font-size|border-radius)$/

/** The sizes the family's `.btn` rule itself sets (its height, padding, corners and font size). */
function familyProps(): Set<string> {
  const out = new Set<string>()
  for (const d of scanCss(FAMILY, fs.readFileSync(path.join(WEB, FAMILY), 'utf8'))) {
    if (d.selectors.some((s) => s.trim() === '.btn') && d.atRules.length === 0 && SIZE.test(d.prop)) out.add(d.prop)
  }
  return out
}

/** `.my-key { min-height: 44px }` beside btn: one class, a property the family sets. */
export function ties(selector: string, prop: string, companions: Set<string>, props: Set<string>): boolean {
  const m = selector.trim().match(/^\.([A-Za-z][\w-]*)$/)
  return !!m && companions.has(m[1]) && props.has(prop)
}

describe('a class beside btn never ties with the family', () => {
  it('finds the family\'s own properties', () => {
    const props = familyProps()
    for (const p of ['min-height', 'padding', 'border-radius']) expect(props.has(p)).toBe(true)
    expect(props.has('background')).toBe(false)
  })

  it('no rule sets a family property on a key beside btn with a one-class selector', () => {
    const companions = btnCompanions()
    const props = familyProps()
    const bad: string[] = []
    // The console's stylesheets and the shipped plugins' (a plugin's CSS is the string its styles.ts exports).
    const sheets: [string, string][] = [...walk(WEB, ['.css']).map((f) => [f, fs.readFileSync(f, 'utf8')] as [string, string]), ...pluginStyles()]
    for (const [file, text] of sheets) {
      const rel = path.relative(WEB, file)
      if (rel === FAMILY) continue
      for (const d of scanCss(rel, text)) {
        for (const s of d.selectors) if (ties(s, d.prop, companions, props)) bad.push(`web/src/${rel}:${d.line} ${s} { ${d.prop} }`)
      }
    }
    expect(bad, `Write it as .btn${'<class>'} so it outranks the family:\n${bad.join('\n')}`).toEqual([])
  })

  it('tells a tie from a stronger selector', () => {
    const c = new Set(['phone-confirm-sheet-btn'])
    const p = new Set(['min-height'])
    expect(ties('.phone-confirm-sheet-btn', 'min-height', c, p)).toBe(true)
    expect(ties('.btn.phone-confirm-sheet-btn', 'min-height', c, p)).toBe(false)
    expect(ties('.sheet .phone-confirm-sheet-btn', 'min-height', c, p)).toBe(false)
    expect(ties('.phone-confirm-sheet-btn', 'flex', c, p)).toBe(false)
    expect(ties('.other-key', 'min-height', c, p)).toBe(false)
  })
})
