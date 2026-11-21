/**
 * A video recorded with the chat's camera reaches the AI as its file, its stills
 * and what was said in it (lib/attachment-headers.ts videoClipBlocks). Every
 * reader of attachment headers must take those two blocks off the person's words
 * and, where it copies files to a session's host, copy the stills too.
 *
 * The class: every parser of the headers. attachment-header-producers.test.ts
 * makes a new one get listed; each listed parser is run here on a video's message.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-video-clip-headers'))

import {
  attachmentHeaderBlock, clipClock, splitAttachmentHeaders, videoClipBlocks,
} from '../../../src/lib/attachment-headers.js'
import { withoutAttachmentHeaders } from '../../../src/core/sessions/session-uploads.js'
import { NO_LINE_WORDS, queueRowView } from '../../../src/core/sessions/queue-row-view.js'
import { attachedFilePaths, attachmentBlocks, rewriteShipped } from '../../../src/providers/outbound-uploads.js'
import { userWordsOf } from '../../../src/core/org/thread-capture.js'
import { splitComposedFraming } from '../../../src/lib/composed-framing.js'

const VIDEO = '/h/tasks/t1/uploads/up-1/camera-141605.webm'
const STILLS = ['/h/tasks/t1/uploads/up-2/camera-141605-still-0m00s.jpg', '/h/tasks/t1/uploads/up-3/camera-141605-still-0m06s.jpg']
const SAID = 'so the request goes into the queue here, then the worker picks it up'

function message(typed = 'what is wrong in the second box?') {
  return attachmentHeaderBlock('files', [VIDEO])
    + videoClipBlocks({ name: 'camera-141605.webm', durationMs: 42_400, stills: STILLS, narration: `  ${SAID}\n  ` })
    + typed
}

describe('videoClipBlocks', () => {
  it('writes the stills block and the words block, byte for byte', () => {
    expect(videoClipBlocks({ name: 'camera-141605.webm', durationMs: 42_400, stills: STILLS, narration: SAID })).toBe(
      '[Video stills — frames of camera-141605.webm (0:42), time in each name; use the Read tool to view them]\n'
      + `- ${STILLS[0]}\n- ${STILLS[1]}\n\n`
      + '[Video narration — what was said in camera-141605.webm]\n'
      + `- ${SAID}\n\n`,
    )
  })

  it('leaves out a block with nothing in it, and keeps a name to one safe line', () => {
    expect(videoClipBlocks({ name: 'a.webm', durationMs: 1000, stills: [], narration: '' })).toBe('')
    expect(videoClipBlocks({ name: 'a.webm', durationMs: 1000, stills: [], narration: 'hi\nthere' }))
      .toBe('[Video narration — what was said in a.webm]\n- hi there\n\n')
    expect(videoClipBlocks({ name: 'x]\ny.webm', durationMs: 0, stills: ['/s.jpg'] })).toMatch(/^\[Video stills — frames of x {2}y\.webm \(0:00\)/)
  })

  it('clipClock is minutes and seconds', () => {
    expect([0, 999, 1500, 42_400, 60_000, 65_000].map(clipClock)).toEqual(['0:00', '0:01', '0:02', '0:42', '1:00', '1:05'])
  })
})

describe('every reader takes a video\'s blocks off the person\'s words', () => {
  it('splitAttachmentHeaders: the video is a file, its stills and words read apart', () => {
    const split = splitAttachmentHeaders(message())
    expect(split.text).toBe('what is wrong in the second box?')
    expect(split.files).toEqual([VIDEO])
    expect(split.stills).toEqual(STILLS)
    expect(split.narration).toEqual([SAID])
    expect(split.images).toEqual([])
  })

  it('two videos, each with its blocks, and pictures in front', () => {
    const two = attachmentHeaderBlock('images', ['/i/p.jpg']) + attachmentHeaderBlock('files', [VIDEO, '/v/b.mp4'])
      + videoClipBlocks({ name: 'camera-141605.webm', durationMs: 5000, stills: STILLS })
      + videoClipBlocks({ name: 'b.mp4', durationMs: 9000, stills: ['/v/b-still-0m00s.jpg'], narration: 'second' })
      + 'both'
    const split = splitAttachmentHeaders(two)
    expect(split.text).toBe('both')
    expect(split.stills).toEqual([...STILLS, '/v/b-still-0m00s.jpg'])
    expect(split.narration).toEqual(['second'])
  })

  it('reads each video\'s stills and words by the video they belong to (the sent bubble shows them on its card)', () => {
    const two = attachmentHeaderBlock('files', [VIDEO, '/v/b.mp4'])
      + videoClipBlocks({ name: 'camera-141605.webm', durationMs: 5000, stills: STILLS })
      + videoClipBlocks({ name: 'b.mp4', durationMs: 9000, stills: ['/v/b-still-0m00s.jpg'], narration: 'second' })
      + 'both'
    expect(splitAttachmentHeaders(two).clips).toEqual([
      { name: 'camera-141605.webm', stills: STILLS },
      { name: 'b.mp4', stills: ['/v/b-still-0m00s.jpg'], narration: 'second' },
    ])
  })

  it('a CRLF message reads the same', () => {
    const split = splitAttachmentHeaders(message().replace(/\n/g, '\r\n'))
    expect(split.files).toEqual([VIDEO])
    expect(split.stills).toEqual(STILLS)
    expect(split.narration).toEqual([SAID])
  })

  it('a spilled paste\'s block stays the person\'s words for a reader, and a file to ship for the shipping lane', () => {
    const text = attachmentHeaderBlock('files', [VIDEO]) + '[Large text attached \u2014 open it from this path]\n- /p/paste-1.txt\n\nhi'
    expect(splitAttachmentHeaders(text).text).toBe('[Large text attached \u2014 open it from this path]\n- /p/paste-1.txt\n\nhi')
    expect(attachmentBlocks(text).map((b) => b.kind)).toEqual(['files', 'paste'])
    expect([...attachedFilePaths(text)]).toEqual([VIDEO, '/p/paste-1.txt'])
  })

  it('the queue card shows the words and the video, never the header text', () => {
    const shown = queueRowView({ id: 'qm-1', status: 'pending', message: message() }, 'sid-1', NO_LINE_WORDS)
    expect(shown.words).toBe('what is wrong in the second box?')
    expect(shown.words).not.toMatch(/Video (?:stills|narration)/)
    expect((shown.files ?? []).map((f) => f.path)).toEqual([VIDEO])
  })

  it('a title reads the words (withoutAttachmentHeaders)', () => {
    expect(withoutAttachmentHeaders(message('the board'))).toBe('the board')
  })

  it('a thread files the words, not the stills or what was said', () => {
    const words = userWordsOf(message('look at the board'), { inChat: true })
    expect(words?.text).toBe('look at the board')
    expect(words?.images).toEqual([])
  })

  it('the composer framing keeps the blocks in front of the words', () => {
    const framed = message('[Re: thread] look')
    const split = splitComposedFraming(framed)
    if (split) expect(split.words.startsWith(attachmentHeaderBlock('files', [VIDEO]).trim())).toBe(true)
  })

  it('a header typed mid-message stays the person\'s', () => {
    const typed = 'see [Video stills — frames of a.webm (0:01), x]\n- /a.jpg'
    expect(splitAttachmentHeaders(typed).text).toBe(typed)
  })
})

describe('a new session\'s first message copies a video\'s stills to its host', () => {
  it('the stills are files to ship; what was said is not a path', () => {
    const blocks = attachmentBlocks(message())
    expect(blocks.map((b) => b.kind)).toEqual(['files', 'stills', 'narration'])
    expect([...attachedFilePaths(message())]).toEqual([VIDEO, ...STILLS])
  })

  it('rewrites the stills\' paths to the host\'s, and never a line of words', () => {
    const shipped = new Map([[VIDEO, '/r/up-1/camera.webm'], [STILLS[0], '/r/up-2/s0.jpg'], [STILLS[1], '/r/up-3/s6.jpg']])
    const said = '/tmp/thing is where I put it'
    const text = attachmentHeaderBlock('files', [VIDEO])
      + videoClipBlocks({ name: 'camera.webm', durationMs: 1000, stills: STILLS, narration: said }) + 'hi'
    const out = rewriteShipped(text, new Map([...shipped, [said, '/never']]))
    expect(out).toContain('- /r/up-1/camera.webm')
    expect(out).toContain('- /r/up-2/s0.jpg\n- /r/up-3/s6.jpg')
    expect(out).toContain(`- ${said}\n`)
    expect(out).not.toContain('/never')
    expect(out.endsWith('hi')).toBe(true)
  })

  it('a narration that is the same text as a still\'s path is still never rewritten (by its line, not its text)', () => {
    const text = attachmentHeaderBlock('files', [VIDEO])
      + videoClipBlocks({ name: 'camera.webm', durationMs: 1000, stills: [STILLS[0]], narration: STILLS[0] }) + 'hi'
    const out = rewriteShipped(text, new Map([[STILLS[0], '/r/s0.jpg']]))
    expect(out).toContain('frames of camera.webm (0:01), time in each name; use the Read tool to view them]\n- /r/s0.jpg\n')
    expect(out).toContain(`what was said in camera.webm]\n- ${STILLS[0]}\n`)
  })

  it('keeps a CRLF message\'s CRs while it rewrites', () => {
    const out = rewriteShipped(message().replace(/\n/g, '\r\n'), new Map([[VIDEO, '/r/v.webm']]))
    expect(out).toContain('- /r/v.webm\r\n')
  })
})
