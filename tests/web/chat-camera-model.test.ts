/**
 * The chat camera's pure rules (web/src/components/chat/camera/camera-model.ts)
 * and what a recorded video sends (web/src/components/common/composer-clip.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  CLIP_COUNTDOWN_FROM_MS, MAX_STILLS, addedLabel, MIN_STILL_CHANGE, cameraErrorKind, captureBaseName, extensionFor, fitLongEdge,
  greySignature, pickRecorderType, pickStills, recordingLabel, signatureDiff, stillName, sttFormatFor,
} from '../../web/src/components/chat/camera/camera-model'
import { clipDetail, clipStillsUploaded, withAttachmentText } from '../../web/src/components/common/composer-clip'
import { savedAttachments, type ComposerAttachment } from '../../web/src/components/common/composer-attachments'
import { splitAttachmentHeaders } from '../../src/lib/attachment-headers'

const s = (atMs: number, score: number) => ({ atMs, score })

describe('pickStills', () => {
  it('keeps the first, then the ones that changed most, in time order', () => {
    const samples = [s(0, 0), s(2000, 0.1), s(4000, 3), s(6000, 0.2), s(8000, 1.2), s(10000, 5)]
    expect(pickStills(samples).map((x) => x.atMs)).toEqual([0, 4000, 8000, 10000])
  })

  it('a board that never changed sends one still', () => {
    expect(pickStills([s(0, 0), s(2000, 0.1), s(4000, MIN_STILL_CHANGE - 0.01)]).map((x) => x.atMs)).toEqual([0])
  })

  it('a minute of change sends at most eight', () => {
    const samples = Array.from({ length: 31 }, (_, i) => s(i * 2000, i === 0 ? 0 : 1 + (i % 7)))
    const picked = pickStills(samples)
    expect(picked).toHaveLength(MAX_STILLS)
    expect(picked[0].atMs).toBe(0)
    expect([...picked].sort((a, b) => a.atMs - b.atMs)).toEqual(picked)
  })

  it('nothing in, nothing out', () => {
    expect(pickStills([])).toEqual([])
  })
})

describe('signatures', () => {
  it('grey bytes, and the share of cells that changed', () => {
    const black = greySignature([0, 0, 0, 255, 0, 0, 0, 255])
    const white = greySignature([255, 255, 255, 255, 255, 255, 255, 255])
    expect([...black]).toEqual([0, 0])
    expect([...white]).toEqual([255, 255])
    expect(signatureDiff(black, white)).toBe(100)
    expect(signatureDiff(black, black)).toBe(0)
    expect(signatureDiff(new Uint8Array(), new Uint8Array())).toBe(0)
  })

  it('a new box on a board counts, a camera\'s noise does not', () => {
    const board = new Uint8Array(64 * 36).fill(228)
    // Noise: every cell a few levels off.
    const noisy = board.map((v, i) => v + ((i % 5) - 2) * 4)
    expect(signatureDiff(board, noisy)).toBe(0)
    // A box outline 8x4 cells (a 130x60 px box on a 640x360 frame) drawn in dark blue.
    const drawn = board.slice()
    for (let x = 10; x < 18; x++) { drawn[15 * 64 + x] = 70; drawn[18 * 64 + x] = 70 }
    for (let y = 15; y < 19; y++) { drawn[y * 64 + 10] = 70; drawn[y * 64 + 17] = 70 }
    expect(signatureDiff(board, drawn)).toBeGreaterThanOrEqual(MIN_STILL_CHANGE)
  })
})

describe('names, formats and labels', () => {
  it('says what the panel put in the message, nothing before the first capture', () => {
    expect(addedLabel(0, 0)).toBeNull()
    expect(addedLabel(1, 0)).toBe('1 photo added')
    expect(addedLabel(3, 0)).toBe('3 photos added')
    expect(addedLabel(0, 1)).toBe('1 video added')
    expect(addedLabel(2, 2)).toBe('2 photos and 2 videos added')
  })

  it('names a capture by when it was taken, a still by its time in the video', () => {
    expect(captureBaseName(new Date(2026, 10, 20, 14, 16, 5))).toBe('camera-141605')
    expect(stillName('camera-141605', 0)).toBe('camera-141605-still-0m00s.jpg')
    expect(stillName('camera-141605', 66_400)).toBe('camera-141605-still-1m06s.jpg')
  })

  it('picks the first recorder format the browser takes', () => {
    expect(pickRecorderType('video', (t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus')
    expect(pickRecorderType('video', (t) => t === 'video/mp4')).toBe('video/mp4')
    expect(pickRecorderType('audio', () => false)).toBe('')
    expect(pickRecorderType('audio', () => { throw new Error('no') })).toBe('')
    expect(extensionFor('video/mp4;codecs=avc1', 'video')).toBe('mp4')
    expect(extensionFor('audio/mp4', 'audio')).toBe('m4a')
    expect(extensionFor('video/webm;codecs=vp8', 'video')).toBe('webm')
    expect(sttFormatFor('audio/webm;codecs=opus')).toBe('webm')
    expect(sttFormatFor('audio/mp4')).toBe('mp4')
  })

  it('scales down, never up', () => {
    expect(fitLongEdge(1920, 1080)).toEqual({ width: 1568, height: 882 })
    expect(fitLongEdge(1080, 1920)).toEqual({ width: 882, height: 1568 })
    expect(fitLongEdge(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('counts up, then down for the last ten seconds', () => {
    expect(recordingLabel(23_400)).toBe('0:23')
    expect(recordingLabel(CLIP_COUNTDOWN_FROM_MS)).toBe('0:10 left')
    expect(recordingLabel(59_100)).toBe('0:01 left')
  })

  it('says why a camera did not start', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied')
    expect(cameraErrorKind({ name: 'NotFoundError' })).toBe('missing')
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('busy')
    expect(cameraErrorKind(new Error('x'))).toBe('failed')
  })
})

const video = (over: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  id: 'att-v', kind: 'file', name: 'camera-141605.webm', size: 2_000_000, mediaType: 'video/webm', status: 'done', sent: 2_000_000,
  path: '/h/up-1/camera-141605.webm',
  clip: { durationMs: 42_000, stills: [{ name: 'a.jpg', path: '/h/up-2/a.jpg' }, { name: 'b.jpg', path: '/h/up-3/b.jpg' }], narration: 'the queue retries' },
  ...over,
})

describe('what a recorded video sends', () => {
  it('the files block names the video, then its stills and words, then the typed words', () => {
    const text = withAttachmentText('look', [video(), { kind: 'file', name: 'log.txt', path: '/h/up-4/log.txt' }])
    const split = splitAttachmentHeaders(text)
    expect(split.files).toEqual(['/h/up-1/camera-141605.webm', '/h/up-4/log.txt'])
    expect(split.stills).toEqual(['/h/up-2/a.jpg', '/h/up-3/b.jpg'])
    expect(split.narration).toEqual(['the queue retries'])
    expect(split.text).toBe('look')
  })

  it('a message with no video is byte for byte what it was', () => {
    expect(withAttachmentText('hi', [{ kind: 'file', name: 'x.pdf', path: '/x.pdf' }]))
      .toBe('[Files attached — open them from these paths]\n- /x.pdf\n\nhi')
    expect(withAttachmentText('hi', [])).toBe('hi')
  })

  it('its card says what goes with it', () => {
    expect(clipDetail(video().clip!)).toBe('0:42 video · 2 stills · what was said')
    expect(clipDetail({ durationMs: 5000, stills: [{ name: 'a' }], narrationNote: 'sound off' })).toBe('0:05 video · 1 still · sound off')
  })

  it('a draft keeps a video only once its stills are up too', () => {
    expect(clipStillsUploaded(video().clip)).toBe(true)
    const halfway = video({ clip: { durationMs: 1000, stills: [{ name: 'a.jpg' }] } })
    expect(clipStillsUploaded(halfway.clip)).toBe(false)
    expect(savedAttachments([halfway])[0].orphan).toBe(true)
    expect(savedAttachments([video()])[0].clip?.stills).toHaveLength(2)
  })
})
