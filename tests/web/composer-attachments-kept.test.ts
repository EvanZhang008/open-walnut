/**
 * The attachments a draft keeps over a reload (composer-attachments.ts): only
 * uploaded ones, pictures without their bytes, and what comes back from storage
 * is checked before the box shows it.
 */
import { describe, it, expect } from 'vitest'
import { ORPHAN_ERROR, parseSavedAttachments, savedAttachments, type ComposerAttachment } from '../../web/src/components/common/composer-attachments'

const file = (over: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  id: 'att-1', kind: 'file', name: 'build.log', size: 42, mediaType: 'text/plain', status: 'done', sent: 42,
  path: '/state/tasks/t1/uploads/up-1/build.log', ...over,
})
const picture = (over: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  id: 'att-2', kind: 'image', name: 'shot.png', size: 70, mediaType: 'image/png', status: 'done', sent: 70,
  image: { data: 'iVBORw0KGgo=', mediaType: 'image/png', name: 'shot.png', url: '/api/images/1-abc.png' }, ...over,
})

describe('kept attachments', () => {
  it('keeps uploaded files and pictures, a picture by its upload only', () => {
    const kept = savedAttachments([file(), picture()])
    expect(kept.map((a) => a.id)).toEqual(['att-1', 'att-2'])
    expect(kept[1].image).toEqual({ data: '', mediaType: 'image/png', name: 'shot.png', url: '/api/images/1-abc.png' })
  })

  it('keeps one not up yet by name only, as a remove-only failure (its bytes are gone after a reload)', () => {
    const kept = savedAttachments([
      file({ id: 'a', status: 'uploading', sent: 10 }),
      file({ id: 'b', status: 'failed', error: 'disk full' }),
      picture({ id: 'd', status: 'preparing', image: { data: 'x', mediaType: 'image/png', name: 'p.png' } }),
    ])
    expect(kept.map((a) => [a.id, a.status, a.orphan, a.error === ORPHAN_ERROR, a.sent])).toEqual([
      ['a', 'failed', true, true, 0], ['b', 'failed', true, true, 0], ['d', 'failed', true, true, 0],
    ])
    expect(kept[2].image).toBeUndefined()
    expect(parseSavedAttachments(JSON.stringify(kept)).map((a) => a.id)).toEqual(['a', 'b', 'd'])
  })

  it('reads back only well-formed entries, and nothing from a broken value', () => {
    const raw = JSON.stringify([file(), { id: 'x', kind: 'file', name: 'n', size: 1, status: 'done' }, picture(), null, 'text'])
    expect(parseSavedAttachments(raw).map((a) => a.id)).toEqual(['att-1', 'att-2'])
    expect(parseSavedAttachments('{not json')).toEqual([])
    expect(parseSavedAttachments(JSON.stringify({ id: 'att-1' }))).toEqual([])
    expect(parseSavedAttachments(null)).toEqual([])
  })

  it('round-trips through storage', () => {
    const kept = savedAttachments([file(), picture()])
    expect(parseSavedAttachments(JSON.stringify(kept))).toEqual(kept)
  })
})
