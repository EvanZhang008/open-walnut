/**
 * Every attachment header Walnut writes is read back off the queue card
 * (lib/attachment-headers.ts, sessions/queue-row-view.ts).
 *
 * 2026-11-06, the user's phone: a picture showed in the queue card as
 * "[Images attached — use the Read tool to view them]" and a path, the text the
 * CLI is given, instead of the picture. The class: every place that writes such a
 * header. Each one is listed below with its role, found by scanning src/ for the
 * header's words, constants and builders; a file that starts writing or naming a
 * header and is not listed fails, and every builder's output goes through the
 * queue display, which must leave no header text and name every path.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-attachment-header-producers'))

import { IMAGES_DIR } from '../../../src/constants.js'
import {
  FILES_ATTACHED_LINE, IMAGES_ATTACHED_LINE, VIDEO_NARRATION_PREFIX, VIDEO_STILLS_PREFIX, attachmentHeaderBlock, imageContextBlock, splitAttachmentHeaders,
} from '../../../src/lib/attachment-headers.js'
import { buildSessionImageContext } from '../../../src/web/routes/images.js'
import { withImagePaths } from '../../../src/core/sessions/cloud-images.js'
import { withFilePaths } from '../../../src/core/sessions/session-uploads.js'
import { picturesHeader } from '../../../src/core/answer-pictures.js'
import { NO_LINE_WORDS, queueRowView } from '../../../src/core/sessions/queue-row-view.js'
import { composeHinted } from '../../../src/core/hints/hint-format.js'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SRC = path.join(REPO, 'src')
/** Where else a header could be written: the web app and the packages a plugin builds on. */
const ALSO = ['web/src', 'packages']

/**
 * Every src file that names an attachment header, and why. `builds`: it writes
 * the header text itself (its output is run below). `calls`: it hands paths to a
 * builder listed here. `reads`: it parses or mentions one (a comment, a parser).
 */
const KNOWN: Record<string, 'defines' | 'builds' | 'calls' | 'reads'> = {
  'lib/attachment-headers.ts': 'defines',
  'core/sessions/cloud-images.ts': 'builds', // withImagePaths
  'core/org/thread-reply.ts': 'calls', // his reply on a thread below, sent to its owner with its pictures' header
  'core/sessions/session-uploads.ts': 'builds', // withFilePaths (the phone writes the same text itself)
  'core/answer-pictures.ts': 'builds', // picturesHeader (letter answers, Board threads, prompt answers)
  'web/routes/session-chat.ts': 'calls', // the web's WS send: attachmentHeaderBlock('images', …)
  'web/routes/session-send-v1.ts': 'calls',
  'web/routes/cloud-session-send.ts': 'calls',
  'web/routes/quick-input-v1.ts': 'calls',
  'web/routes/images.ts': 'calls', // buildSessionImageContext: imageContextBlock (the second form)
  'web/routes/api-v1.ts': 'calls', // the Personal AI's session handoff: buildSessionImageContext
  'web/routes/chat.ts': 'calls', // the same, from the chat route
  'web/routes/sessions.ts': 'calls', // the session start and send routes: buildSessionImageContext
  'core/send-queue.ts': 'calls',
  'core/send-queue-sweep.ts': 'calls',
  'core/leader/host-session-control.ts': 'calls', // withAnswerImagePaths: a prompt's answer with pictures, the companion leading the host
  'core/session-channel/companion-host-ops.ts': 'calls', // a send or an answer with pictures to a session its host judges, the Mac away
  'lib/composed-framing.ts': 'reads', // splitAttachmentHeaders: the pictures stay ahead of the words, the framing after them comes off
  'core/session-hooks/builtins.ts': 'reads', // a comment about titles
  'core/sessions/transcript-from-jsonl.ts': 'reads', // a comment
  'providers/user-line-images-core.ts': 'reads', // the daemon turns the header's paths into image blocks
  'providers/daemon-source.ts': 'reads', // the daemon's self-test of that parser
  'providers/outbound-uploads.ts': 'reads', // a comment: it copies a file header's paths to the session's host
  // Outside src/ (paths from the repo root).
  '../web/src/hooks/useSessionSend.ts': 'reads', // splitAttachmentHeaders for the waiting bubble
  '../web/src/utils/thread-card.ts': 'reads', // questionPartsOf: a question card's bubble shows the pictures, not the header
  '../web/src/components/sessions/optimistic-dedup.ts': 'reads', // a comment on dedup
  '../web/src/api/file-upload.ts': 'calls', // the web's withFilePaths: attachmentHeaderBlock('files', …)
  '../web/src/components/chat/ChatInput.tsx': 'reads', // a comment: the send names files under the header
  '../web/src/components/common/composer-clip.ts': 'calls', // the composer's send: attachmentHeaderBlock('files', …) and videoClipBlocks
  '../web/src/components/common/composer-attachments.ts': 'reads', // a comment
  '../web/src/components/sessions/DraftSessionPanel.tsx': 'reads', // a comment
  '../web/src/components/sessions/MessageAttachments.tsx': 'reads', // a comment: the cards drawn from the headers
  '../web/src/components/sessions/SessionMessage.tsx': 'reads', // a comment: the bubble splits the headers off
}

// `Images\|Files` and `Video \(stills`: a hand-written parser's regex names the header that way
// (2026-11-20: three parsers of their own knew only pictures and files, so a recorded video's
// stills were not copied to a session's host and its words showed as the person's).
const NAMES = /IMAGES_ATTACHED_LINE|FILES_ATTACHED_LINE|(?:Images|Files) attached|Images\|Files|Video (?:stills|narration)|Video \(stills|The user attached|attachmentHeaderBlock\(|imageContextBlock\(|buildSessionImageContext\(|withImagePaths\(|withAnswerImagePaths\(|withFilePaths\(|videoClipBlocks\(/

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') srcFiles(p, out) }
    else if (/\.(?:ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

/** A builder's text as the queue card reads it. */
function card(message: string) {
  return queueRowView({ id: 'qm-1', status: 'pending', message }, 'sid-1', NO_LINE_WORDS)
}

function expectClean(message: string, typed: string, images: string[], files: string[]) {
  const shown = card(message)
  expect(shown.words).toBe(typed)
  expect(shown.words).not.toMatch(/(?:Images|Files) attached|The user attached/)
  expect((shown.images ?? []).map((i) => i.path)).toEqual(images)
  expect((shown.images ?? []).every((i) => i.url.startsWith('/api/v1/media?path='))).toBe(true)
  expect((shown.files ?? []).map((f) => f.path)).toEqual(files)
  // `message` keeps its frozen meaning: an older phone resends it, headers and all.
  expect(shown.message).toBe(message)
}

describe('every file that writes or names an attachment header is listed', () => {
  it('the scan finds exactly the listed files', () => {
    const found = [SRC, ...ALSO.map((d) => path.join(REPO, d))].flatMap((d) => srcFiles(d))
      .filter((f) => NAMES.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .sort()
    expect(found).toEqual(Object.keys(KNOWN).sort())
  })

  it('a file that calls a builder really calls one listed here, and builds no header by hand', () => {
    for (const [rel, role] of Object.entries(KNOWN)) {
      const src = readFileSync(path.join(SRC, rel), 'utf8')
      if (role === 'calls') expect(src, rel).toMatch(/withImagePaths\(|withAnswerImagePaths\(|withFilePaths\(|attachmentHeaderBlock\(|imageContextBlock\(|buildSessionImageContext\(/)
      if (role === 'calls' || role === 'builds') {
        // The header line is written only by lib/attachment-headers.ts, never as a literal (comments aside).
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        expect(code, rel).not.toMatch(/['"`]\[(?:Images|Files) attached|['"`]The user attached/)
      }
    }
  })

  it('the phone writes the files header byte for byte the same', () => {
    const swift = readFileSync(path.join(REPO, 'ios-native/Walnut/Core/AttachmentHeaders.swift'), 'utf8')
    const line = /static let filesLine = "([^"]+)"/.exec(swift)?.[1]?.replace('\\u{2014}', '\u2014')
    expect(line).toBe(FILES_ATTACHED_LINE)
    // A recorded video's two blocks start the same on the phone (attachment-headers.ts videoClipBlocks).
    const unescape = (v?: string) => v?.replace('\\u{2014}', '\u2014')
    expect(unescape(/static let videoStillsPrefix = "([^"]+)"/.exec(swift)?.[1])).toBe(VIDEO_STILLS_PREFIX)
    expect(unescape(/static let videoNarrationPrefix = "([^"]+)"/.exec(swift)?.[1])).toBe(VIDEO_NARRATION_PREFIX)
  })
})

describe('every builder\'s text reads back as the typed words plus its attachments', () => {
  it('attachmentHeaderBlock, both kinds, alone and together', () => {
    expectClean(`${attachmentHeaderBlock('images', ['/i/a.png'])}hi`, 'hi', ['/i/a.png'], [])
    expectClean(`${attachmentHeaderBlock('files', ['/f/a.pdf', '/f/b.mov'])}hi`, 'hi', [], ['/f/a.pdf', '/f/b.mov'])
    expectClean(`${attachmentHeaderBlock('files', ['/f/a.pdf'])}${attachmentHeaderBlock('images', ['/i/a.png'])}two\n\nparagraphs`,
      'two\n\nparagraphs', ['/i/a.png'], ['/f/a.pdf'])
    expect(attachmentHeaderBlock('images', [])).toBe('')
  })

  it('withImagePaths (the web, the phone, the companion, held sends, prompt answers)', () => {
    expectClean(withImagePaths('look', ['/i/a.png', '/i/b.jpg']), 'look', ['/i/a.png', '/i/b.jpg'], [])
    // A picture with no words: the card shows the picture and no text.
    expectClean(withImagePaths('', ['/i/a.png']), '', ['/i/a.png'], [])
  })

  it('withFilePaths (the phone\'s files), with pictures too', () => {
    expectClean(withFilePaths('the clip', ['/f/clip.mov']), 'the clip', [], ['/f/clip.mov'])
    expectClean(withImagePaths(withFilePaths('both', ['/f/x.pdf']), ['/i/y.png']), 'both', ['/i/y.png'], ['/f/x.pdf'])
  })

  it('picturesHeader (letter answers, Board threads)', async () => {
    await fs.mkdir(IMAGES_DIR, { recursive: true })
    const name = `header-guard-${process.pid}.png`
    await fs.writeFile(path.join(IMAGES_DIR, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    try {
      const header = await picturesHeader([name])
      expectClean(`${header}the answer`, 'the answer', [path.join(IMAGES_DIR, name)], [])
    } finally {
      await fs.rm(path.join(IMAGES_DIR, name), { force: true })
    }
  })

  it('imageContextBlock (buildSessionImageContext: the web session routes, the Personal AI handoff)', () => {
    // Byte for byte what those routes sent before the builder moved (the model reads it).
    const old = (paths: string[]) => `The user attached ${paths.length === 1 ? 'an image' : `${paths.length} images`}. Read ${paths.length === 1 ? 'this file' : 'these files'} for visual context:\n${paths.join('\n')}\n\n`
    for (const paths of [['/i/a.png'], ['/i/a.png', '/i/b png.jpg', '/i/c.webp']]) {
      expect(imageContextBlock(paths)).toBe(old(paths))
      expect(buildSessionImageContext(paths.map((filePath) => ({ filePath })))).toBe(old(paths))
      expectClean(`${imageContextBlock(paths)}what is this`, 'what is this', paths, [])
    }
    expect(imageContextBlock([])).toBe('')
    // The count is read: a line after the named paths is the person's.
    expectClean(`${imageContextBlock(['/i/a.png'])}/not/a/path/just words`, '/not/a/path/just words', ['/i/a.png'], [])
    // A sentence naming more paths than follow is not one Walnut wrote.
    const short = 'The user attached 2 images. Read these files for visual context:\n/i/a.png'
    expect(splitAttachmentHeaders(short).text).toBe(short)
  })

  it('a header under Walnut\'s hint blocks reads back the same', () => {
    const lang = '<system-reminder>\nWalnut (reply-language): Answer in English.\n</system-reminder>'
    const text = composeHinted(withImagePaths('hinted', ['/i/a.png']), { before: [lang], after: [] })
    const shown = card(text)
    expect(shown.words).toBe('hinted')
    expect(shown.images?.map((i) => i.path)).toEqual(['/i/a.png'])
  })

  it('header words a person typed mid-message, or a header with no path, stay as typed', () => {
    const typed = `see this: ${IMAGES_ATTACHED_LINE}`
    expect(card(typed).words).toBe(typed)
    expect(splitAttachmentHeaders(`${IMAGES_ATTACHED_LINE}\nno path line`).text).toBe(`${IMAGES_ATTACHED_LINE}\nno path line`)
  })
})
