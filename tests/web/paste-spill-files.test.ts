/**
 * A message too long for one frame is spilled to a file (web/src/api/paste-spill.ts),
 * but the attached files' header stays in the message: the server reads it there to
 * copy the files to a remote session's host, and the bubble shows them as cards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const posted: Array<{ text: string }> = []
vi.mock('../../web/src/api/client', () => ({
  apiPost: vi.fn(async (_url: string, body: { text: string }) => {
    posted.push(body)
    return { path: '/state/pastes/p-1.txt', chars: body.text.length }
  }),
}))

const { spillOversizedText, PASTE_SPILL_THRESHOLD } = await import('../../web/src/api/paste-spill')
const { withFilePaths, splitAttachmentHeaders } = await import('../../web/src/api/file-upload')

beforeEach(() => { posted.length = 0 })

describe('spilling a long message with attached files', () => {
  it('spills only the words and keeps the files header in front', async () => {
    const words = 'x'.repeat(PASTE_SPILL_THRESHOLD + 10)
    const out = await spillOversizedText(withFilePaths(words, ['/state/tasks/t/uploads/up-1/a.log']))
    expect(posted).toEqual([{ text: words }])
    const parts = splitAttachmentHeaders(out)
    expect(parts?.files).toEqual(['/state/tasks/t/uploads/up-1/a.log'])
    expect(parts?.body).toMatch(/^\[Large text attached — 200,010 chars/)
    expect(parts?.body).toContain('- /state/pastes/p-1.txt')
  })

  it('leaves a message alone when its words alone fit', async () => {
    const msg = withFilePaths('short', ['/p/up-1/a.log'])
    expect(await spillOversizedText(msg)).toBe(msg)
    expect(posted).toEqual([])
  })

  it('spills a long message with no files as before', async () => {
    const words = 'y'.repeat(PASTE_SPILL_THRESHOLD + 1)
    const out = await spillOversizedText(words)
    expect(posted).toEqual([{ text: words }])
    expect(out.startsWith('[Large text attached')).toBe(true)
  })
})
