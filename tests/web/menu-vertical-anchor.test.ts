/**
 * Which element gives a menu its anchor's top and bottom (web/src/hooks/menu-vertical-anchor.ts).
 *
 * 2026-11-25: the 2026-11-22 rule "an upward menu from inside a composer clears the whole
 * composer" read an empty `verticalAnchorRef` as "not given", so the engine settings popover,
 * which names the composer box only while it is short, was lifted over a tall draft again
 * (engine-settings-popover-r2.spec "tall draft" red on trunk). The matrix below walks every
 * input the choice reads; the source check keeps every caller of useMenuPlacement on this one
 * choice, so a new caller with its own anchor gets the same rule.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { verticalAnchorOf, type AnchorCandidate } from '../../web/src/hooks/menu-vertical-anchor'

interface Stub extends AnchorCandidate { name: string }
const el = (name: string, inside: Record<string, Stub | null> = {}): Stub => ({
  name,
  closest: (selector: string) => inside[selector] ?? null,
})
const composer = el('composer')
const phoneComposer = el('phone-composer')
const own = el('own')
const pill = el('pill', { '.chat-input-container': composer, '.session-panel-input': phoneComposer })
const submenuRow = el('submenu-row', { '.chat-input-container': composer, '.wn-menu, [role="menu"]': el('menu') })
const loose = el('loose')

const GIVEN = { none: undefined, empty: { current: null }, set: { current: own } } as const

describe('verticalAnchorOf', () => {
  for (const [givenName, given] of Object.entries(GIVEN)) {
    for (const bounds of ['layout', 'visual'] as const) {
      for (const preferSide of ['up', 'down'] as const) {
        for (const beside of [false, true]) {
          for (const trigger of [pill, submenuRow, loose]) {
            const label = `${givenName} ref, ${bounds}, ${preferSide}, beside=${beside}, ${trigger.name}`
            it(label, () => {
              const got = verticalAnchorOf<Stub>({ given, trigger, bounds, preferSide, beside })?.name ?? 'trigger'
              let want: string
              if (givenName === 'set') want = 'own'
              else if (bounds === 'visual') want = trigger === pill ? 'phone-composer' : trigger === submenuRow ? 'composer' : 'trigger'
              // A caller that named its own anchor and has none now gets the trigger, never a guess.
              else if (givenName === 'empty') want = 'trigger'
              else if (preferSide === 'up' && !beside && trigger === pill) want = 'composer'
              else want = 'trigger'
              expect(got).toBe(want)
            })
          }
        }
      }
    }
  }
})

describe('one place chooses the vertical anchor', () => {
  it('useMenuPlacement reads its verticalAnchorRef only through verticalAnchorOf (and its resize watch)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/hooks/useMenuPlacement.ts'), 'utf8')
    const uses = src.split('\n').filter((l) => /verticalAnchorRef/.test(l) && !/^\s*(\*|\/\/)/.test(l))
    const allowed = [
      /verticalAnchorRef\?: RefObject/,
      /edgeOverflow = 'flip', verticalAnchorRef,/,
      /verticalAnchorOf<HTMLElement>\(\{ given: verticalAnchorRef,/,
      /if \(verticalAnchorRef\?\.current\) ro\.observe\(verticalAnchorRef\.current\)/,
      /\[open, triggerRef, menuRef, .*verticalAnchorRef/,
    ]
    expect(uses.filter((l) => !allowed.some((a) => a.test(l)))).toEqual([])
    expect(src).not.toMatch(/closest<HTMLElement>\('\.chat-input-container'\)/)
  })
})

/**
 * Every caller that names its own vertical anchor, and why. A named anchor wins, and an empty one
 * means "the trigger" (never the composer default), so a caller whose ref is empty only because
 * it has no anchor of its own must pass none instead (2026-11-25: the mic's retry list passed its
 * always-empty field ref and stayed at the mic, over the draft). A new caller fails here until it
 * says which it is.
 */
const NAMED_ANCHORS: Record<string, string> = {
  'web/src/components/sessions/EngineSettingsPopover.tsx': 'the composer box while it is short; empty for a tall draft, so the bottom sits on the "+" row',
  'web/src/components/sessions/TriggerPickerPopover.tsx': 'the composer box from the engine settings entry, empty for a tall draft',
  'web/src/components/sessions/LatestUpdatePopover.tsx': 'the composer box from the engine settings entry, empty for a tall draft',
  'web/src/components/common/MicPopover.tsx': 'the field a bubble is drawn above; none for the retry list',
  'web/src/components/tasks/PrPill.tsx': 'its row, opening downward',
  'web/src/components/tasks/ChangePill.tsx': 'its list, opening downward',
}

describe('every caller naming a vertical anchor is listed', () => {
  it('names the same files as web/src', () => {
    const root = path.resolve(__dirname, '../../web/src')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.endsWith('useMenuPlacement.ts') && /verticalAnchorRef:/.test(fs.readFileSync(p, 'utf8'))) {
          found.push(path.relative(path.resolve(__dirname, '../..'), p))
        }
      }
    }
    walk(root)
    expect(found.sort()).toEqual(Object.keys(NAMED_ANCHORS).sort())
  })
})
