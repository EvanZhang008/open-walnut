/**
 * A web answer box (useImageAttachments, PictureStrip) says what an add did not take: one past
 * the five-picture limit, a file that is not a PNG, JPEG, GIF or WebP picture, one that could not
 * be read. It used to leave them out without a word (2026-11-23: what a message carries is never
 * lost silently). The browser flow is tests/e2e/browser/answer-box-pictures.spec.ts.
 */
import { describe, it, expect } from 'vitest'
import { leftOutNotice, MAX_IMAGES } from '@/components/common/image-attachments'
import { isStaleImageRefError, withoutUploadedNames } from '@/api/image-upload'

describe('the line an add leaves beside the box', () => {
  it('is null when everything was taken', () => {
    expect(leftOutNotice({ over: 0, notPictures: [], unreadable: [] })).toBeNull()
  })

  it('names each reason once, with the files it names', () => {
    expect(leftOutNotice({ over: 1, notPictures: [], unreadable: [] }))
      .toBe(`Only ${MAX_IMAGES} pictures fit in one message; 1 was not added.`)
    expect(leftOutNotice({ over: 3, notPictures: ['notes.pdf'], unreadable: ['broken.png'] }))
      .toBe(`Only ${MAX_IMAGES} pictures fit in one message; 3 were not added. notes.pdf is not a PNG, JPEG, GIF or WebP picture. broken.png could not be read.`)
    expect(leftOutNotice({ over: 0, notPictures: ['a.heic', 'b.bmp'], unreadable: [] }))
      .toBe('a.heic, b.bmp are not a PNG, JPEG, GIF or WebP picture.')
  })
})

describe('a session retry whose uploaded picture is gone', () => {
  it('knows the server\'s refusal for a gone upload', () => {
    expect(isStaleImageRefError('Picture 2 of 2 is no longer on the server. Remove it and attach it again.')).toBe(true)
    expect(isStaleImageRefError('WebSocket disconnected')).toBe(false)
    expect(isStaleImageRefError(undefined)).toBe(false)
  })

  it('drops the upload names so the bytes go up again; null when a picture has only its name', () => {
    const withBytes = [{ data: 'AAAA', mediaType: 'image/png', name: 'a.png', url: '/api/images/1-a.png' }]
    expect(withoutUploadedNames(withBytes)).toEqual([{ data: 'AAAA', mediaType: 'image/png', name: 'a.png' }])
    expect(withoutUploadedNames([{ data: '', mediaType: 'image/png', name: 'b.png', url: '/api/images/1-b.png' }])).toBeNull()
    expect(withoutUploadedNames(undefined)).toBeNull()
  })
})
