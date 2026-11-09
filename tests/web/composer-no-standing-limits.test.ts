/**
 * A composer says an attachment limit only where one is hit (the 6th picture,
 * a picture over the size, a file refused), never as a standing line while
 * nothing is over a limit (2026-11-09, the user, of "Up to 10 files (4 GB each)
 * and 5 images per message" and "One picture goes as a file ..." under a TIFF:
 * "nonono don't show this").
 *
 * Two guards: the strip rendered with attachments under every limit shows no
 * limit words; and every line of web/src that writes a limit constant into a
 * text is listed here as a place a limit is hit, so a new standing line fails.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
import { ComposerAttachmentStrip } from '../../web/src/components/chat/ComposerAttachmentStrip'
import { pictureLimitHit, type ComposerAttachment, type ComposerAttachments } from '../../web/src/components/common/composer-attachments'

const LIMIT_WORDS = /up to \d|per message|GB each|MB each|as (a )?files?|\d+ (files|images|pictures)\b|images? fit|files? fit/i

function strip(items: ComposerAttachment[], extra: Partial<{ sendWhenReady: boolean; kept: boolean }> = {}): string {
  const attachments = {
    items, add: async () => null, retry: () => {}, remove: () => {}, clear: () => {}, restore: () => {}, fillImage: () => {},
    pending: items.filter((a) => a.status === 'preparing' || a.status === 'uploading').length,
    failed: items.filter((a) => a.status === 'failed').length,
    imageCount: items.filter((a) => a.kind === 'image').length,
    fileCount: items.filter((a) => a.kind === 'file').length,
  } satisfies ComposerAttachments
  return renderToStaticMarkup(createElement(ComposerAttachmentStrip, { attachments, sendWhenReady: false, ...extra }))
    .replace(/<[^>]+>/g, ' ')
}

const file = (over: Partial<ComposerAttachment>): ComposerAttachment => ({
  id: `a-${Math.random()}`, kind: 'file', name: 'build.log', size: 2_000_000, mediaType: 'text/plain', status: 'done', sent: 2_000_000, path: '/h/build.log', ...over,
})
const picture = (over: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  id: `p-${Math.random()}`, kind: 'image', name: 'shot.png', size: 40_000, mediaType: 'image/png', status: 'done', sent: 40_000,
  image: { data: '', mediaType: 'image/png', name: 'shot.png', url: '/i/shot.png' } as ComposerAttachment['image'], ...over,
})

describe('the composer shows no limits while nothing is over one', () => {
  it.each([
    ['a TIFF (a file, not a picture past a limit)', [file({ name: 'scan.tiff', mediaType: 'image/tiff', size: 1_900_000 })]],
    ['one picture', [picture()]],
    ['five pictures', [1, 2, 3, 4, 5].map(() => picture())],
    ['a file uploading', [file({ status: 'uploading', sent: 500_000 })]],
    ['a file waiting', [file({ status: 'preparing', sent: 0 })]],
    ['a failed file', [file({ status: 'failed', error: 'the host did not answer' })]],
    ['a converted photo', [file({ name: 'IMG.jpg', mediaType: 'image/jpeg', converted: true })]],
    ['a TIFF uploading', [file({ name: 'scan.tiff', mediaType: 'image/tiff', status: 'uploading', sent: 100 })]],
    ['ten files and five pictures', [...Array.from({ length: 10 }, () => file({})), ...[1, 2, 3, 4, 5].map(() => picture())]],
  ])('%s', (_name, items) => {
    expect(strip(items)).not.toMatch(LIMIT_WORDS)
    expect(strip(items, { sendWhenReady: true })).not.toMatch(LIMIT_WORDS)
  })

  it('says a limit on the attachment that hit it', () => {
    const sixth = file({ name: 'shot6.png', mediaType: 'image/png', limit: pictureLimitHit(new File([''], 'shot6.png', { type: 'image/png' }), true) })
    const text = strip([1, 2, 3, 4, 5].map(() => picture()).concat(sixth))
    expect(text).toContain('Over 5 pictures, sent as a file')
    expect(text.match(/sent as a file/g)).toHaveLength(1)
  })

  it('says it while that attachment still uploads', () => {
    const limit = 'Over 7 MB, sent as a file'
    expect(strip([file({ name: 'big.png', mediaType: 'image/png', status: 'uploading', sent: 10, limit })])).toContain(limit)
    expect(strip([file({ name: 'big.png', mediaType: 'image/png', status: 'preparing', sent: 0, limit })])).toContain(limit)
  })

  it('a picture over the size, and nothing for a file that is no picture', () => {
    const big = new File([new Uint8Array(8 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    expect(pictureLimitHit(big, false)).toBe('Over 7 MB, sent as a file')
    expect(pictureLimitHit(new File(['x'], 'scan.tiff', { type: 'image/tiff' }), false)).toBeUndefined()
    expect(pictureLimitHit(new File(['x'], 'a.pdf', { type: 'application/pdf' }), false)).toBeUndefined()
  })
})

// --- Source guard: every text built from a limit constant is a place a limit is hit.

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')
const LIMIT_MODULES = /from '[^']*(image-attachments|file-upload|composer-attachments)'/
// A template literal, or JSX text (`{MAX_IMAGES} images`), that writes a limit constant.
const LIMIT_TEXT = /`[^`]*\$\{\s*(formatBytes\()?MAX_(IMAGES|FILES|FILE_BYTES|IMAGE_BYTES)\b|(^|[^$])\{\s*(formatBytes\()?MAX_(IMAGES|FILES|FILE_BYTES|IMAGE_BYTES)\b/

/** Each line (trimmed) that writes a limit into a text, and when it shows. */
const SAID_WHEN_HIT: Record<string, string> = {
  'api/file-upload.ts|if (size > MAX_FILE_BYTES) throw new FileUploadError(`Files can be at most ${formatBytes(MAX_FILE_BYTES)}`, \'too_large\');':
    'an upload refused for its size, said on that file\'s card as its error',
  'components/common/composer-attachments.ts|left.push(picture ? `Only ${MAX_IMAGES} images fit in one message`':
    'an attach a picture-only box refused, said in the notice of that attach',
  'components/common/composer-attachments.ts|: isPictureFile(file) ? `${original.name || \'That picture\'} is over ${formatBytes(MAX_IMAGE_BYTES)}`':
    'a picture a picture-only box refused for its size, said in the notice of that attach',
  'components/common/composer-attachments.ts|if (countOf(\'file\') >= MAX_FILES) { left.push(`Only ${MAX_FILES} files fit in one message`); continue; }':
    'the 11th file, refused, said in the notice of that attach',
  'components/common/composer-attachments.ts|if (file.size > MAX_FILE_BYTES) { left.push(`${original.name} is over ${formatBytes(MAX_FILE_BYTES)}`); continue; }':
    'a file over the size, refused, said in the notice of that attach',
  'components/common/composer-attachments.ts|if (picture) return `Over ${MAX_IMAGES} pictures, sent as a file`;':
    'pictureLimitHit: on the card of the picture past the count',
  'components/common/composer-attachments.ts|if (isPictureFile(file) && file.size > MAX_IMAGE_BYTES) return `Over ${formatBytes(MAX_IMAGE_BYTES)}, sent as a file`;':
    'pictureLimitHit: on the card of the picture past the size',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(path.relative(WEB_SRC, full))
  }
  return out
}

describe('every limit text in web/src is said where a limit is hit', () => {
  const found: string[] = []
  for (const rel of walk(WEB_SRC)) {
    const src = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')
    const defines = /export const MAX_(IMAGES|FILES|FILE_BYTES|IMAGE_BYTES)\b/.test(src)
    if (!defines && !LIMIT_MODULES.test(src)) continue
    for (const line of src.split('\n')) {
      if (/^\s*import\b/.test(line)) continue
      if (LIMIT_TEXT.test(line)) found.push(`${rel}|${line.trim()}`)
    }
  }

  it('finds the limit texts', () => {
    expect(found.length).toBeGreaterThanOrEqual(4)
  })

  it.each(found)('%s', (key) => {
    expect(SAID_WHEN_HIT[key], `${key}\nA text naming an attachment limit: say it only where the limit is hit, then list it here with when it shows.`).toBeTruthy()
  })

  it('lists no line that is gone', () => {
    expect(Object.keys(SAID_WHEN_HIT).filter((k) => !found.includes(k))).toEqual([])
  })
})
