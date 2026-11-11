/**
 * The composer's handlers rebuild its text from what the box holds now, never from the `value`
 * of the render they were made in (2026-11-11, the user: "even when that happens can we
 * guarantee the basic type, this is so core"). Under load a render lags the keys, so a handler
 * that splices a pick, a command, a dictation or a send out of render state puts back what was
 * typed since. Every handler reads `liveText()` (the textarea's own value).
 *
 * This lists every read of the render state `value` in ChatInput.tsx. A read the list does not
 * name (a new handler, a new splice) fails here: read `liveText()` instead, or, for a read that
 * only draws the render, add it below with why.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(__dirname, '../../web/src/components/chat/ChatInput.tsx')

/** Reads of `value` that only draw the render or mirror it, each with why. */
const RENDER_READS: Record<string, string> = {
  'const [value, setValue] = useState(initialDraft.body);': 'the state itself',
  'valueRef.current = value;': 'the mirror that liveText falls back to when no box is mounted',
  '}, [value, fitForText]);': 'the fit effect is keyed on it; it reads the box itself',
  'onValueChangeRef.current?.(composeRefs(value, tableRef.current));': 'reports the rendered text upward, read-only',
  '}, [value]);': 'that mirror effect is keyed on it',
  'value,': 'the pill layer draws the rendered text',
  'const hasInput = !!(value.trim() || hasAttachments);': 'draws the send button state',
  'const untouched = !!recallRef.current && recallRef.current.text === value && !hasAttachments;': 'draws the recall menu row',
  "const empty = (value === '' && !hasAttachments) || untouched;": 'draws the recall menu row',
  '{recallShown && recallShown.text === value && (': 'draws the recall hint',
}

function valueReads(src: string): string[] {
  const out: string[] = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    // `value` as its own name: not `.value`, `valueRef`, `onValueChange`, a CSS class.
    if (/(?<![.\w-])value(?![\w-])/.test(line.replace(/'[^']*'|"[^"]*"/g, ''))) out.push(line)
  }
  return out
}

describe('composer handlers read the live text', () => {
  it('every read of the render state value is a render read on the list', () => {
    const reads = valueReads(readFileSync(FILE, 'utf8'))
    const unlisted = reads.filter((l) => !(l in RENDER_READS))
    expect(unlisted, 'read liveText() in a handler, or list a render-only read in RENDER_READS').toEqual([])
  })

  it('the list names only reads that still exist', () => {
    const reads = new Set(valueReads(readFileSync(FILE, 'utf8')))
    expect(Object.keys(RENDER_READS).filter((l) => !reads.has(l))).toEqual([])
  })

  it('the handlers that splice text read liveText', () => {
    const src = readFileSync(FILE, 'utf8')
    for (const name of ['handleSelectCommand', 'handleMentionSelect', 'handleMentionSetQuery', 'handlePickRef', 'sendNow', 'writeDictation', 'refineDictation', 'interruptNow']) {
      const at = src.indexOf(`const ${name} = `)
      expect(at, name).toBeGreaterThan(0)
      expect(src.slice(at, at + 400), name).toContain('liveText()')
    }
  })
})
