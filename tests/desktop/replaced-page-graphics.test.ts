/**
 * The replaced-page native test (tests/desktop/replaced-page-process-tests.swift) proves a swap
 * gives a page's graphics back, and needs a Mac that charges pages graphics to prove it. GitHub's
 * macOS runners have no GPU of their own: every page read 0 MB and the precondition failed
 * (Nightly extra tests 45101869535), while this Mac reads 554 MB before and 8 MB after. The two
 * graphics checks step aside only on such a machine, and only when every page reads none; a
 * footprint that cannot be read still fails, and a GPU's Mac still checks both.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const src = fs.readFileSync(path.resolve(__dirname, 'replaced-page-process-tests.swift'), 'utf8')
const swap = src.slice(src.indexOf('func swap()'), src.indexOf('func swapNow()'))

describe('the graphics checks step aside only on a Mac with no page graphics', () => {
  it('an unreadable footprint counts as a failure, never as no graphics', () => {
    expect(swap).toMatch(/let before = pids\.map \{ graphicsMB\(\$0\) \?\? -1 \}/)
  })

  it('the skip needs every page to read none, and otherwise both checks run', () => {
    expect(swap).toMatch(/if !before\.isEmpty && before\.allSatisfy\(\{ \$0\.isNaN \|\| \$0 == 0 \}\) \{/)
    const checked = swap.slice(swap.indexOf('} else {'))
    expect(checked).toContain('"each page holds graphics before the swap')
    expect(checked).toContain('"a page emptied in its process gives its graphics back before it is ended"')
  })
})
