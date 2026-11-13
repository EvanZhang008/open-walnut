/**
 * GET /messages/:accountId/:messageId/attachments/:attachmentId[?download=1]: one attachment's bytes.
 *
 * Streamed straight from the provider, never cached (see attachments.ts for the header rules). Like
 * every route that reaches a provider it is refused on a replica, and it is bounded twice: the open
 * (until the first byte) under the provider deadline, and the whole stream under the route's own
 * lifetime. When the browser goes away, the request's signal aborts and the provider closes its
 * connection, which is what stops the download on the mail server's side.
 *
 *   200 the bytes, with `Content-Disposition` inline only for a PDF or a raster image
 *   400 { error: 'invalid' }              a segment is missing
 *   404 { error: 'unknown_message' | 'unknown_attachment' | 'not-found' }
 *   413 { error: 'too-large' }            over the 50 MB cap
 *   501 { error: 'unsupported' }          the account's provider cannot download attachments
 *   502 { error: 'unreachable' }          the mail server did not answer
 *
 * POST /messages/:accountId/:messageId/attachments/:attachmentId/save: the same file, written to the
 * Downloads folder of the user this server runs as (`MailAttachments.save`). It is the Mac app's
 * Download: that web view has no download of its own, and the app always loads this Mac's own
 * server. So it answers only a caller on this Mac (a browser elsewhere downloads with a link), never
 * a replica, and never a test run, whose writes must not reach the person's own folders.
 *
 *   200 { saved: true, name, path }       the file is on disk under `name`
 *   200 { saved: false, error, message }  the copy failed or stopped part way; nothing was kept
 *   403 { error: 'local_only' }           the caller is not on this Mac
 *   409 { error: 'test_run' | 'no_downloads_folder' | 'exists' }
 *   and the GET's 404, 413, 501 and 502 for an attachment that cannot be opened
 *
 * The answer's status and headers go out once the file is open, and its body when the last byte is
 * written: that keeps a slow copy inside the route's long lifetime rather than the host's one-minute
 * wait for a handler.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { ambientTestRun } from '../../core/test-run.js'
import { LOCAL_ORIGIN, ORIGIN_HEADER } from '../../lib/caller-origin.js'
import { ATTACHMENT_STREAM_MS, attachmentHeaders, type MailAttachments, type SavingAttachment } from './attachments.js'
import { errorReply, firstQuery, PRIMARY_ONLY, providerErrorCode, reasonOf, segmentsAfter } from './contract.js'

const TEST_RUN_SAVE = {
  status: 409,
  json: { error: 'test_run', message: "A test run cannot save files: it would write into this Mac's Downloads folder." },
}

const LOCAL_ONLY = {
  status: 403,
  json: { error: 'local_only', message: 'Saving to Downloads works only on this Mac. Download the file in your browser instead.' },
}

export function registerMailAttachmentRoutes(
  walnut: WalnutServerPluginApi,
  deps: { attachments: MailAttachments },
): void {
  walnut.http.route('get', '/messages/:accountId/:messageId/attachments/:attachmentId', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const [accountId, messageId, marker, attachmentId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId || marker !== 'attachments' || !attachmentId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id, a message id and an attachment id are required' } }
    }
    const download = firstQuery(request.query.download) === '1'
    try {
      const opened = await deps.attachments.open(accountId, messageId, attachmentId, request.signal)
      return {
        headers: attachmentHeaders(opened, { download }),
        body: reported(opened.content, (error) => {
          // The response is already under way, so the browser sees a cut download; the reason is here.
          if (!request.signal.aborted) {
            walnut.log.warn('mail attachment stream failed', { accountId, attachmentId, error: reasonOf(error).slice(0, 200) })
          }
        }),
        timeoutMs: ATTACHMENT_STREAM_MS,
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
  registerSaveRoute(walnut, deps)
}

function registerSaveRoute(walnut: WalnutServerPluginApi, deps: { attachments: MailAttachments }): void {
  walnut.http.route('post', '/messages/:accountId/:messageId/attachments/:attachmentId/save', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    if (ambientTestRun()) return TEST_RUN_SAVE
    // Set by the host from the socket and its headers, over anything the client sent
    // (plugin-route-dispatcher.ts): `__local__` only for a caller on this Mac.
    if (request.headers[ORIGIN_HEADER] !== LOCAL_ORIGIN) return LOCAL_ONLY
    const [accountId, messageId, marker, attachmentId, action] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId || marker !== 'attachments' || !attachmentId || action !== 'save') {
      return { status: 400, json: { error: 'invalid', message: 'an account id, a message id and an attachment id are required' } }
    }
    try {
      const saving = await deps.attachments.save(accountId, messageId, attachmentId, request.signal)
      return {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: answerWhenSaved(saving, (error) => {
          walnut.log.warn('mail attachment save failed', { accountId, attachmentId, error: reasonOf(error).slice(0, 200) })
        }),
        timeoutMs: ATTACHMENT_STREAM_MS,
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}

/** The save's one JSON answer, sent when the copy ended. */
async function* answerWhenSaved(saving: SavingAttachment, onError: (error: unknown) => void): AsyncGenerator<Uint8Array> {
  let answer: Record<string, unknown>
  try {
    await saving.done
    answer = { saved: true, name: saving.name, path: saving.path }
  } catch (error) {
    onError(error)
    const code = (error as { code?: unknown } | null)?.code
    answer = { saved: false, error: providerErrorCode(error) ?? (typeof code === 'string' ? code : 'internal'), message: reasonOf(error) }
  }
  yield new TextEncoder().encode(JSON.stringify(answer))
}

/** The same bytes, with a failure mid-stream reported before it ends the response. */
async function* reported(content: AsyncIterable<Uint8Array>, onError: (error: unknown) => void): AsyncGenerator<Uint8Array> {
  try {
    yield* content
  } catch (error) {
    onError(error)
    throw error
  }
}
