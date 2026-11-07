/**
 * A reloaded panel's waiting bubbles from `session:get-queue` (useSessionSend
 * queueRowBubble, components/sessions/QueuedImageThumbs.tsx).
 *
 * 2026-11-06: a row stays queued after the CLI read its line, until the model
 * answers (line-answer-v1). The queue now says how far each row got (`stage`,
 * `delivered`) and names its pictures (`images`). A row the CLI read has no
 * bubble (history shows it), and pictures show as thumbnails, never as the
 * header text the CLI is given.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { editedBubble, queueRowBubble, type QueueRowWire } from '@/hooks/useSessionSend'
import { QueuedImageThumbs } from '@/components/sessions/QueuedImageThumbs'
import { attachmentHeaderBlock } from '@open-walnut/attachment-headers'

const row = (over: Partial<QueueRowWire>): QueueRowWire => ({ id: 'qm-1', message: 'hello', status: 'pending', stage: 'waiting', delivered: false, ...over })

describe('queueRowBubble', () => {
  it('a row the CLI already read has no waiting bubble (the chat shows it from history)', () => {
    expect(queueRowBubble(row({ status: 'processing', stage: 'taken', delivered: true }))).toBeNull()
    // An older server's row says neither: it keeps its bubble as before.
    expect(queueRowBubble({ id: 'qm-2', message: 'hi', status: 'processing' })).toMatchObject({ status: 'delivered' })
  })

  it('a written row reads delivered as a live one does after its write (no stage note that could go stale); a waiting row stays editable', () => {
    // A reloaded tab is never told when the CLI reads a row already counted delivered at its write.
    const written = queueRowBubble(row({ status: 'processing', stage: 'written' }))!
    expect(written.status).toBe('delivered')
    expect(written).not.toHaveProperty('stage')
    expect(queueRowBubble(row({}))!.status).toBe('received')
  })

  it('pictures show as thumbnails and the header text never as words', () => {
    const message = `${attachmentHeaderBlock('images', ['/i/a.png'])}${attachmentHeaderBlock('files', ['/f/clip.mov'])}look at this`
    const url = '/api/v1/media?path=%2Fi%2Fa.png&session=s1'
    const bubble = queueRowBubble(row({ message, images: [{ path: '/i/a.png', url }] }))!
    expect(bubble.text).toBe('look at this')
    expect(bubble.text).not.toMatch(/attached/)
    expect(bubble.imageUrls).toEqual([url])
    // History echoes the composed text: the bubble dedups against that.
    expect(bubble.dedupText).toBe(message)
    const html = renderToStaticMarkup(createElement(QueuedImageThumbs, { urls: bubble.imageUrls }))
    expect(html).toContain(`src="${url.replace(/&/g, '&amp;')}"`)
    expect(html).not.toMatch(/attached —/)
    expect(renderToStaticMarkup(createElement(QueuedImageThumbs, { urls: [] }))).toBe('')
  })

  it('an edit keeps the dedup text in step: history echoes the kept headers with the new words', () => {
    const header = attachmentHeaderBlock('images', ['/i/a.png'])
    const bubble = queueRowBubble(row({ message: `${header}old words` }))!
    expect(bubble.dedupText).toBe(`${header}old words`)
    const edited = editedBubble(bubble, 'new words')
    expect(edited).toMatchObject({ text: 'new words', dedupText: `${header}new words` })
    expect(editedBubble(queueRowBubble(row({ message: 'plain' }))!, 'plainer')).toMatchObject({ text: 'plainer' })
    expect(editedBubble(queueRowBubble(row({ message: 'plain' }))!, 'plainer').dedupText).toBeUndefined()
  })

  it('keeps who sent it, so an agent card still folds', () => {
    expect(queueRowBubble(row({ sentBy: 'agent' }))).toMatchObject({ sentBy: 'agent' })
    expect(queueRowBubble(row({ sentBy: 'person' }))).toMatchObject({ sentBy: 'person' })
  })

  it('the queued row renders the thumbnails', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../../web/src/components/sessions/SessionChatHistory.tsx'), 'utf8')
    expect(src).toContain('<QueuedImageThumbs urls={m.images?.length ? undefined : m.imageUrls} />')
  })
})
