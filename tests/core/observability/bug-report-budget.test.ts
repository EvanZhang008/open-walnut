/**
 * The bug report scrubs push device tokens before its size budget cuts the text.
 *
 * The budget keeps the head and the tail of the largest section and drops its
 * middle. A token the cut split no longer matches whole, so only its first 12
 * characters (the legacy log slice) would still be replaced, and the rest of
 * the head it left would ride the report. Here a token sits right across the
 * cut: where the cut lands is read from the same text without the token.
 */
import { describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bug-report-budget'))

import { finishBundleText } from '../../../src/core/observability/bug-report.js'

const MARK = '\n[... truncated for total size ...]\n'
const TOKEN = crypto.randomBytes(32).toString('hex')
const windows = Array.from({ length: TOKEN.length - 9 }, (_, i) => TOKEN.slice(i, i + 10))

/** A bundle whose largest section is well over the budget. */
function bundle(filler: string): string {
  return [
    'WALNUT DIAGNOSTIC BUNDLE (server)',
    '\n=== meta ===\nwindow 30m',
    `\n=== recent server log ===\n${filler}`,
    '\n=== collection notes ===\n(all sections collected cleanly)',
  ].join('\n')
}

describe('the bug report scrubs device tokens before its size budget', () => {
  it('a token right across the cut leaves no piece of itself', async () => {
    const plain = bundle('x'.repeat(700 * 1024))
    const cutText = await finishBundleText(plain, [], [])
    const cutAt = cutText.indexOf(MARK)
    expect(cutAt).toBeGreaterThan(1024)
    // The token starts 40 characters before the cut, in a text of the same length.
    const at = cutAt - 40
    const withToken = plain.slice(0, at) + TOKEN + plain.slice(at + TOKEN.length)
    expect(withToken.length).toBe(plain.length)
    const out = await finishBundleText(withToken, [TOKEN], [])
    expect(out).toContain(MARK)
    expect(windows.filter((w) => out.includes(w))).toEqual([])
    expect(out).toContain('token#')
  })

  it('under the budget nothing is cut, and the token is still replaced', async () => {
    const out = await finishBundleText(bundle(`a line with ${TOKEN} in it`), [TOKEN], [])
    expect(out).not.toContain(MARK)
    expect(windows.filter((w) => out.includes(w))).toEqual([])
    expect(out).toContain('a line with token#')
  })
})
