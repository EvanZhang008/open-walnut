/**
 * What a click on a mail attachment does, and that the console and the server agree about it.
 *
 * 2026-11-13: a PDF chip in the reader did nothing. A chip now opens its file, and the decision of
 * HOW is made twice, once on each side: the console picks a viewer (`attachmentViewer`) and the server
 * picks the response headers (`inlineTypeOf`, attachments.ts). If the two lists drift, the console
 * opens an image viewer on a file the server sends as a download, which renders as a broken image, or
 * the server serves inline a type the console would never show. The parity case below is the guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { attachmentHeaders, inlineTypeOf, safeFilename } from '../../src/integrations/mail/attachments'

const apiPost = vi.fn()
vi.mock('../../web/src/api/client', async (load) => ({ ...(await load<Record<string, unknown>>()), apiPost: (...args: unknown[]) => apiPost(...args) }))

const { mailAttachmentUrl, mailRequestFailure, saveMailAttachment } = await import('../../web/src/api/mail')
type MailProviderSummary = import('../../web/src/api/mail').MailProviderSummary
const { canOpenAttachments } = await import('../../web/src/apps/mail/mail-providers')
const { attachmentViewer } = await import('../../web/src/apps/mail/mail-reader-format')
const { attachmentFileName, attachmentLabel, attachmentName } = await import('../../web/src/apps/mail/mail-format')
const { saveStatusLine, savesThroughServer } = await import('../../web/src/apps/mail/mail-attachment-save')
const { inMacApp } = await import('../../web/src/utils/mac-app')
const { MailReaderBody } = await import('../../web/src/apps/mail/MailReaderBody')

const TYPES = [
  'application/pdf', 'APPLICATION/PDF', 'application/pdf; name=x.pdf',
  'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/heic', 'image/tiff', 'image/bmp',
  'text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript', 'text/plain',
  'application/octet-stream', 'application/zip', 'message/rfc822', '', 'nonsense',
]

describe('a click on an attachment', () => {
  it('opens a PDF and the four raster formats in Walnut, and downloads everything else', () => {
    const kind = (mimeType: string, filename = 'file') => attachmentViewer({ id: '2', mimeType, filename })
    expect(kind('application/pdf')).toBe('pdf')
    for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) expect(kind(type)).toBe('image')
    // Script can live in all of these, so none is ever rendered: a plain download.
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'text/plain', 'application/zip', 'nonsense']) {
      expect(kind(type), type).toBe('download')
    }
    // A provider that labels everything octet-stream still sends PDFs; the PDF viewer reads the bytes.
    expect(kind('application/octet-stream', 'Report.PDF')).toBe('pdf')
    expect(kind('', 'report.pdf')).toBe('pdf')
    // ...but a declared type is never overridden by a name.
    expect(kind('text/html', 'report.pdf')).toBe('download')
    expect(kind('application/octet-stream', 'photo.png')).toBe('download')
  })

  it('the console views exactly what the server serves inline', () => {
    for (const mimeType of TYPES) {
      const viewer = attachmentViewer({ id: '2', mimeType, filename: 'file' })
      const served = inlineTypeOf(mimeType)
      expect(viewer === 'image', `${mimeType}: image viewer vs inline image`).toBe(!!served?.startsWith('image/'))
      expect(viewer === 'pdf', `${mimeType}: pdf viewer vs inline pdf`).toBe(served === 'application/pdf')
      // Whatever is not inline goes out as an octet-stream download, which only a link may ask for.
      const headers = attachmentHeaders({ mimeType, filename: 'file' })
      if (!served) {
        expect(headers['Content-Type'], mimeType).toBe('application/octet-stream')
        expect(headers['Content-Disposition'], mimeType).toMatch(/^attachment; /)
      }
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
      expect(headers['Content-Security-Policy']).toContain('sandbox')
    }
  })

  it('opens only for a provider that declares downloads', () => {
    const provider = (id: string, attachments: 'none' | 'metadata' | 'download') => ({ id, capabilities: { attachments } }) as unknown as MailProviderSummary
    const providers = [provider('imap', 'download'), provider('outlook', 'metadata'), provider('quiet', 'none')]
    expect(canOpenAttachments(providers, 'imap:me@example.invalid')).toBe(true)
    expect(canOpenAttachments(providers, 'outlook:me@example.invalid')).toBe(false)
    expect(canOpenAttachments(providers, 'quiet:me@example.invalid')).toBe(false)
    // A provider the list does not know yet: no click, since it could only fail.
    expect(canOpenAttachments(providers, 'unknown:me@example.invalid')).toBe(false)
  })

  it('names one attachment of one message, each segment encoded, and asks for a download only when told', () => {
    expect(mailAttachmentUrl('imap:me@example.invalid', 'Projects/2026: old:9001:7', '1.2'))
      .toBe('/api/plugins/mail/messages/imap%3Ame%40example.invalid/Projects%2F2026%3A%20old%3A9001%3A7/attachments/1.2')
    expect(mailAttachmentUrl('imap:a', 'INBOX:1:2', '2', { download: true })).toBe('/api/plugins/mail/messages/imap%3Aa/INBOX%3A1%3A2/attachments/2?download=1')
  })
})

describe('a filename from a stranger', () => {
  it('keeps no control character, bidi override, path or leading dot, and never comes back empty', () => {
    expect(safeFilename('a\r\nb\u0000c.pdf')).toBe('abc.pdf')
    expect(safeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFilename('  .hidden ')).toBe('hidden')
    expect(safeFilename('')).toBe('attachment')
    expect(safeFilename(undefined)).toBe('attachment')
    expect([...safeFilename('x'.repeat(400))]).toHaveLength(150)
  })
})

describe('a body notice', () => {
  // Kept for every failure, too-large and not-found included: an older release can mark a big mail
  // too-large again after the one-time sweep, and a folder the server would not open reads as
  // not-found. A notice with no way to ask again strands the mail.
  it.each(['too-large', 'not-found', 'auth', 'unreachable', 'rate-limit', 'unknown'])('offers Try again for %s', (code) => {
    const open = { accountId: 'imap:a', messageId: 'INBOX:1:2', message: null, body: null, bodyError: code, loading: false, error: null, allowRemoteImages: false }
    const html = renderToStaticMarkup(createElement(MailReaderBody, { open }))
    expect(html).toContain('data-testid="mail-body-error"')
    expect(html).toContain('Try again')
  })
})

describe('a name from a stranger, shown', () => {
  // Test data: a bidi override, the isolates, the marks and a line break, written as escapes.
  const HOSTILE = ['invoice\u202Efdp.exe', 'a\u2066b\u2069c\u200ed\u200f.pdf', 'Q3\r\nnotes.txt', '  .hidden  ', 'x/y\\z.txt', '']

  it('loses its control and bidi characters by the server\'s own rule, in the chip, the label and the saved name', () => {
    expect(attachmentName({ filename: 'invoice\u202Efdp.exe' })).toBe('invoicefdp.exe')
    expect(attachmentName({ filename: 'a\u2066b\u2069c\u200ed\u200f.pdf' })).toBe('abcd.pdf')
    expect(attachmentName({ filename: '' })).toBe('Attachment')
    expect(attachmentLabel({ filename: 'invoice\u202Efdp.exe', bytes: 2048 })).toBe('invoicefdp.exe (2.0 KB)')
    for (const filename of HOSTILE) {
      // The name a browser saves the file as is the one the server's header and Downloads use.
      expect(attachmentFileName({ filename })).toBe(safeFilename(filename))
      expect(attachmentName({ filename })).not.toMatch(/[\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/)
    }
  })

  it('decides the viewer from the name it shows', () => {
    // A mark after the extension does not hide a PDF from the PDF viewer.
    expect(attachmentViewer({ id: '2', mimeType: 'application/octet-stream', filename: 'report.pdf\u200f' })).toBe('pdf')
  })
})

describe('the Mac app', () => {
  const withHandlers = (handlers: Record<string, unknown> | undefined) => {
    vi.stubGlobal('window', handlers ? { webkit: { messageHandlers: handlers } } : {})
  }
  afterEach(() => { vi.unstubAllGlobals(); apiPost.mockReset() })

  it('is told from a browser by its own message handlers, and only there does Download go through the server', () => {
    withHandlers(undefined)
    expect(inMacApp()).toBe(false)
    expect(savesThroughServer()).toBe(false)
    withHandlers({})
    expect(inMacApp()).toBe(false)
    for (const name of ['walnutChrome', 'walnutClipboard', 'walnutUpdate']) {
      withHandlers({ [name]: { postMessage() {} } })
      expect(inMacApp(), name).toBe(true)
      expect(savesThroughServer(), name).toBe(true)
    }
  })

  it("posts to the attachment's save route and reads the answer the server sends when the copy ended", async () => {
    apiPost.mockResolvedValueOnce({ saved: true, name: 'survey (1).pdf', path: '/Users/robin/Downloads/survey (1).pdf' })
    await expect(saveMailAttachment('imap:a', 'INBOX:1:2', '1.2')).resolves.toEqual({ name: 'survey (1).pdf', path: '/Users/robin/Downloads/survey (1).pdf' })
    expect(apiPost.mock.calls[0]![0]).toBe('/api/plugins/mail/messages/imap%3Aa/INBOX%3A1%3A2/attachments/1.2/save')
    // A copy that failed part way answers 200 with its reason, and nothing was kept.
    apiPost.mockResolvedValueOnce({ saved: false, error: 'unreachable', message: 'The mail server closed the connection.' })
    await expect(saveMailAttachment('imap:a', 'INBOX:1:2', '2')).rejects.toThrow('The mail server closed the connection.')
  })

  it("says where the file went, and a failure in the server's own words", () => {
    expect(saveStatusLine({ kind: 'idle' })).toBeNull()
    expect(saveStatusLine({ kind: 'saving', id: '2', name: 'survey.pdf' })).toBe('Saving survey.pdf to Downloads...')
    expect(saveStatusLine({ kind: 'saved', id: '2', name: 'survey (1).pdf' })).toBe('Saved to Downloads as survey (1).pdf')
    const refused = Object.assign(new Error('no_downloads_folder'), { body: { error: 'no_downloads_folder', message: 'There is no Downloads folder at /Users/robin/Downloads, so Walnut did not save the attachment.' } })
    const reason = mailRequestFailure(refused)
    expect(reason).toContain('There is no Downloads folder')
    expect(saveStatusLine({ kind: 'failed', id: '2', name: 'survey.pdf', reason })).toBe(`Could not save survey.pdf: ${reason}`)
  })
})
