/**
 * An arm that ignores input for a moment after something appears judges the input by when it
 * was pressed (web/src/utils/input-time.ts), and every browser spec that presses a prompt key
 * waits for the card to say it is armed.
 *
 * 2026-11-26: tests/e2e/browser/permission-prompt-keys.spec.ts failed now and then on a loaded
 * machine. The prompt card's key arm compared the time the page HANDLED a key with when the card
 * appeared, so a key pressed as the prompt arrived but handled late by a busy page landed on it
 * (the case the arm exists for); and the specs pressed keys after guessed sleeps or retries,
 * because nothing said when a card was armed.
 *
 * The members are read from source, so a new one fails here until it is decided:
 * - every `*ARM*_MS` window in web/src is classified: an input gate imports inputPressedAt; a
 *   window that is not one says why;
 * - every test in tests/e2e/browser that presses a page-level digit or Enter while a prompt card
 *   is on the page waits for `data-prompt-keys="armed"` first, or says it presses before the arm.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WEB_SRC = path.join(ROOT, 'web/src')
const SPECS = path.join(ROOT, 'tests/e2e/browser')

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js)$/.test(ent.name)) out.push(p)
  }
  return out
}

type Kind = { gate: true } | { gate: false; why: string }
const GATE: Kind = { gate: true }
const notGate = (why: string): Kind => ({ gate: false, why })

const ARM_WINDOWS: Record<string, Kind> = {
  'components/sessions/prompt-keys.ts': GATE,
  'hooks/useArmAfterAppear.ts': GATE,
  'components/approvals/ApprovalPrompts.tsx': GATE,
  'hooks/useOutsidePress.ts': notGate('attaches its listener after the opening click; judges no input by time'),
  'components/sessions/BackgroundTaskStopButton.tsx': notGate('how long a first click stays armed for its confirming second click'),
  'components/settings/inputs/InlineConfirmButton.tsx': notGate('how long a first click stays armed for its confirming second click'),
  'components/board/board-elements.frame.js': notGate('how long a first click on a message delete stays armed for its confirming second click'),
}

const ARM_CONST = /\b(?:const|let|var)\s+((?:[A-Z]+_)*ARM(?:_[A-Z]+)*_MS)\s*=/

describe('an input arm reads when the input was pressed', () => {
  const found = walk(WEB_SRC).filter((f) => ARM_CONST.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(WEB_SRC, f)).sort()

  it('every arm window in web/src is classified', () => {
    expect(found).toEqual(Object.keys(ARM_WINDOWS).sort())
  })

  it.each(Object.entries(ARM_WINDOWS).filter(([, k]) => k.gate))('%s judges input by inputPressedAt, not by the clock at handling', (rel) => {
    const src = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')
    expect(src).toMatch(/import \{[^}]*\binputPressedAt\b[^}]*\} from '@\/utils\/input-time'/)
    expect(src).toMatch(/inputPressedAt\(/)
  })
})

describe('a spec presses a prompt key only once the card is armed', () => {
  const PROMPT_CARD = /permission-request-card|ask-user-question-card|data-prompt-pending/
  // A digit or Enter sent to the page, by press or type (a key name like Digit1 too).
  const PAGE_KEY = /keyboard\.(?:press|type)\(\s*['"`](?:Digit|Numpad)?([1-9]|Enter)['"`]/
  const WAITS = /data-prompt-keys|\barmed\(|prompt-keys: before arm/

  const offenders: string[] = []
  for (const file of walk(SPECS).filter((f) => f.endsWith('.spec.ts'))) {
    const src = fs.readFileSync(file, 'utf8')
    if (!PROMPT_CARD.test(src)) continue
    // One chunk per test: from each `test(` to the next.
    const starts = [...src.matchAll(/^\s*test(?:\.(?:only|fixme|skip|fail))?\(\s*['"`]/gm)].map((m) => m.index ?? 0)
    starts.forEach((start, i) => {
      const body = src.slice(start, starts[i + 1] ?? src.length)
      const press = body.search(PAGE_KEY)
      if (press < 0) return
      // The wait comes before the first key, not after it.
      if (!WAITS.test(body.slice(0, press))) offenders.push(`${path.relative(ROOT, file)}: ${body.trim().split('\n')[0].slice(0, 120)}`)
    })
  }

  it('every such test waits for data-prompt-keys="armed" (or says it presses before the arm)', () => {
    expect(offenders).toEqual([])
  })
})
