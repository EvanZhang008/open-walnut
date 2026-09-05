/**
 * SMTP: one message, one connection, and an honest answer about how far it got.
 *
 * The only interesting question this file answers is `stage`, because that is what decides
 * whether the base may ever let a human retry. SMTP has no idempotency and no dedupe: a message
 * the server took is gone, and there is no way to ask it "did you already get this?". So a wrong
 * "safe to retry" is a duplicate mail sent over the user's own name, and a wrong "unknown" is
 * only an extra question in the human inbox. The asymmetry is why every doubt resolves to
 * `after-data`.
 *
 * The stage is derived from the PROTOCOL POSITION nodemailer reports on the error (`err.command`,
 * plus the codes that have only one possible site), and `classify` below documents the table. The
 * obvious alternative, "did anything read the composed message", was measured against a scripted
 * SMTP server and is WRONG: `smtp-connection.send()` pipes the whole message into a throwaway
 * stream on the envelope-error path, so a mistyped address drains the body without DATA ever
 * beginning, and a byte-based reading turns a typo into an unretriable `unknown`. The byte signal
 * survives for two narrower jobs: it captures the exact MIME for the Sent copy, and it is the
 * tie-breaker for the transient socket codes nodemailer reports from one position for two
 * completely different events.
 *
 * Two smaller rules the code keeps, each with a cost behind it:
 *
 * - The `Message-ID` is DERIVED from the idempotency key, so the same approved revision always
 *   produces the same id. If a retry ever does happen (a human deciding after checking the Sent
 *   folder), a well behaved server and the recipient's client can both recognise the duplicate.
 * - The transporter is built per send with `pool: false` and closed in a `finally`. A pooled
 *   connection would hold an authenticated socket to the user's provider open between messages,
 *   and mail is not a hot path: one connection per send costs a handshake nobody notices.
 */
import crypto from 'node:crypto'
import { PassThrough, type Transform } from 'node:stream'
import type { Transporter, TransportOptions } from 'nodemailer'
import type { MailAddress, ProviderErrorCode } from '../mail/api.js'

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpSettings {
  host: string
  port: number
  security: SmtpSecurity
}

export interface SmtpMessage {
  from: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  bcc?: MailAddress[]
  subject: string
  /** The markdown source, which is also the `text/plain` alternative. */
  text: string
  html?: string
  inReplyTo?: string
  references?: string[]
  /** `<draftId>:<revision>`, from the base's ledger. The Message-ID is derived from it. */
  idempotencyKey: string
}

export interface SmtpSendResult {
  providerMessageId: string
  acceptedAt: number
  /**
   * Exactly the bytes that went over DATA, when they fit under the capture cap.
   *
   * Kept so the Sent folder can be given the SAME message rather than a re-composed lookalike:
   * two composes of one mail differ in boundary strings and header order, and a Sent copy that
   * does not match what the recipient got is a small lie in the one place a user checks.
   */
  raw?: Buffer
}

/** Above this the sent copy is not captured. An APPEND is best effort; heap pressure is not. */
const RAW_CAPTURE_MAX_BYTES = 4 * 1024 * 1024

export interface SmtpError extends Error {
  code: ProviderErrorCode
  stage: 'before-data' | 'after-data'
}

function sendError(
  code: ProviderErrorCode,
  message: string,
  stage: 'before-data' | 'after-data',
): SmtpError {
  const error = new Error(message) as SmtpError
  error.code = code
  error.stage = stage
  return error
}

/**
 * Where in the conversation nodemailer produced an error, read from its OWN `command` field.
 *
 * Every failure site in `smtp-connection/index.js` goes through `_formatError(msg, code, response,
 * command)`, which sets `err.code`, `err.command` and `err.responseCode`. `command` is therefore a
 * protocol POSITION, and a position is what decides whether the server could have taken the
 * message. These are the positions at or before the DATA command's own response.
 */
const PRE_DATA_COMMANDS = new Set([
  'CONN', 'API', 'LHLO', 'EHLO', 'HELO', 'STARTTLS', 'MAIL FROM', 'RCPT TO',
])

/**
 * Codes nodemailer can ONLY produce before the body is transmitted, whatever else is true.
 *
 * `EENVELOPE` covers a refused sender, a refused recipient, and the DATA command itself being
 * answered with anything but a go-ahead (`_actionDATA`). `EAUTH` and `EDNS` have no site past the
 * envelope at all. These three are proof, not a guess, so they do not consult the byte signal.
 */
const PRE_DATA_ONLY_CODES = new Set(['EENVELOPE', 'EAUTH', 'EDNS'])

/** An auth rejection is the one failure whose fix is a credential, so it keeps its own code. */
function codeFor(raw: string | undefined): ProviderErrorCode {
  if (raw === 'EAUTH') return 'auth'
  if (raw === 'EENVELOPE' || raw === 'EMESSAGE') return 'invalid'
  return 'unreachable'
}

export type SmtpTransportFactory = (options: TransportOptions) => Promise<Transporter>

const realFactory: SmtpTransportFactory = async (options) => {
  const nodemailer = await import('nodemailer')
  return nodemailer.createTransport(options)
}

let factory: SmtpTransportFactory = realFactory

/** Test seam: a fake transporter instead of a socket. Pass `null` to restore the real one. */
export function setSmtpTransportFactory(fake: SmtpTransportFactory | null): void {
  factory = fake ?? realFactory
}

/**
 * The `Message-ID` for an approved revision, the same every time.
 *
 * Hashed, never the key itself: a Message-ID travels to the recipient and into their client's
 * UI, and a draft id is Walnut's internal bookkeeping. The domain comes from the sending address
 * because that is the only domain this message can honestly claim.
 */
export function messageIdFor(idempotencyKey: string, address: string): string {
  const hash = crypto.createHash('sha1').update(idempotencyKey).digest('hex')
  const at = address.lastIndexOf('@')
  const domain = at > 0 ? address.slice(at + 1).trim().toLowerCase() : 'localhost'
  return `<walnut-${hash}@${domain}>`
}

function transportOptions(settings: SmtpSettings, user: string, password: string): TransportOptions {
  return {
    host: settings.host,
    port: settings.port,
    // `secure` means TLS from the first byte (465). STARTTLS is a plaintext connect that MUST be
    // upgraded, and `requireTLS` is what makes the upgrade mandatory rather than best effort: a
    // server that quietly does not offer STARTTLS would otherwise get the password in the clear.
    secure: settings.security === 'tls',
    ...(settings.security === 'starttls' ? { requireTLS: true } : {}),
    ...(settings.security === 'none' ? { ignoreTLS: true } : {}),
    auth: { user, pass: password },
    // Never pooled: see the file comment.
    pool: false,
    // The library's own logging would put the credential in a log line. There is no setting that
    // keeps the useful half, so it is off, and this module logs what it needs itself.
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  }
}

interface SmtpLog {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

/**
 * Connect, authenticate, send nothing.
 *
 * The setup probe: it proves the SMTP half of an account before the account is stored, so a
 * wrong port or a password the outgoing server refuses is discovered while the human is still
 * looking at the form rather than at a letter whose Send button fails.
 */
export async function verifySmtp(input: {
  settings: SmtpSettings
  user: string
  password: string
  timeoutMs: number
}): Promise<void> {
  const transporter = await factory(transportOptions(input.settings, input.user, input.password))
  try {
    await withDeadline(
      transporter.verify(),
      input.timeoutMs,
      'the outgoing mail server did not answer',
      'before-data',
    )
  } catch (error) {
    throw classify(error, false)
  } finally {
    try { transporter.close() }
    catch { /* a transporter that cannot close is already gone */ }
  }
}

/**
 * Send one message. Exactly one attempt, and one answer about how far it got.
 *
 * The caller (the base's ledger) has already decided this message may be sent; this function's
 * whole job is to do it once and then be precise about the outcome.
 */
export async function sendMail(input: {
  settings: SmtpSettings
  user: string
  password: string
  message: SmtpMessage
  log: SmtpLog
  timeoutMs: number
}): Promise<SmtpSendResult> {
  const { message } = input
  const messageId = messageIdFor(message.idempotencyKey, message.from.address)
  const transporter = await factory(transportOptions(input.settings, input.user, input.password))

  let bytesRead = false
  const captured: Buffer[] = []
  let capturedBytes = 0
  try {
    transporter.use('stream', (mail, callback) => {
      // A fake transporter in a test may not implement the plugin pipeline at all. Missing it
      // costs the sent copy and the transient-code tie-breaker, not the send.
      if (typeof mail?.message?.transform !== 'function') { callback(); return }
      mail.message.transform((): Transform => {
        const tap = new PassThrough()
        tap.on('data', (chunk: Buffer) => {
          bytesRead = true
          if (capturedBytes > RAW_CAPTURE_MAX_BYTES) return
          capturedBytes += chunk.length
          if (capturedBytes <= RAW_CAPTURE_MAX_BYTES) captured.push(Buffer.from(chunk))
        })
        return tap
      })
      callback()
    })
  } catch (error) {
    input.log.debug('smtp stream hook could not be attached', { error: String(error).slice(0, 200) })
  }

  try {
    const info = await withDeadline(
      transporter.sendMail({
        from: { ...(message.from.name ? { name: message.from.name } : {}), address: message.from.address },
        to: message.to.map(toAddress),
        ...(message.cc?.length ? { cc: message.cc.map(toAddress) } : {}),
        ...(message.bcc?.length ? { bcc: message.bcc.map(toAddress) } : {}),
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.references?.length ? { references: message.references } : {}),
        messageId,
        date: new Date(),
      }),
      input.timeoutMs,
      'the outgoing mail server did not finish the message',
      // OUR deadline fired, so no response ever arrived and the position is whatever the byte signal
      // can prove. Nothing read means the message never left the composer and a retry is safe; any
      // byte read leaves it unknowable, and unknowable has to read as unsafe. This used to be a flat
      // 'after-data', which made a wrong port a permanent `unknown` nobody could resolve.
      () => (bytesRead ? 'after-data' : 'before-data'),
    )
    // `response` is the server's reply to the end of DATA, so its presence IS the acceptance. An
    // `info` without one means the transport resolved without the server ever saying yes, which
    // is not something to report as sent.
    if (!info?.response) {
      throw sendError(
        'unreachable',
        'The outgoing mail server closed the message without accepting it.',
        bytesRead ? 'after-data' : 'before-data',
      )
    }
    if (info.rejected?.length) {
      // Some recipients were refused and others were not: the message WAS sent, so this is a log
      // line rather than a failure. Reporting it as failed would invite a retry that delivers the
      // mail a second time to everybody who did get it.
      input.log.warn('smtp accepted the message but refused some recipients', {
        rejected: info.rejected.length, accepted: info.accepted?.length ?? 0,
      })
    }
    input.log.info('smtp accepted a message', {
      host: input.settings.host, messageId, recipients: info.accepted?.length ?? message.to.length,
    })
    return {
      providerMessageId: info.messageId || messageId,
      acceptedAt: Date.now(),
      ...(captured.length > 0 && capturedBytes <= RAW_CAPTURE_MAX_BYTES
        ? { raw: Buffer.concat(captured) }
        : {}),
    }
  } catch (error) {
    throw classify(error, bytesRead)
  } finally {
    try { transporter.close() }
    catch { /* a transporter that cannot close is already gone */ }
  }
}

function toAddress(address: MailAddress): { name?: string; address: string } {
  return { ...(address.name ? { name: address.name } : {}), address: address.address }
}

/**
 * A transport failure as a staged ProviderError.
 *
 * The stage comes from the PROTOCOL POSITION nodemailer reports, not from whether bytes were read
 * out of the composed message. Reading bytes looks like the perfect signal and is not one: on the
 * envelope-error path `smtp-connection.send()` pipes the whole message into a throwaway
 * `PassThrough` just to avoid holding it in memory, so a mistyped recipient drains the message
 * without DATA ever beginning. Measured against a scripted server: RCPT 550 and a refused DATA
 * command both drained the body, and a byte-based reading called them both `after-data`, which
 * made a typo an unretriable `unknown`.
 *
 * `bytesRead` is still consulted, in exactly one place: for the transient codes (`ETIMEDOUT`,
 * `ECONNECTION`, `ESOCKET`, `ETLS`, `EPROTOCOL`, `ESTREAM`) nodemailer reports at `command: 'CONN'`
 * from BOTH the socket-timeout and the closed-connection handlers, so the code alone cannot say
 * whether the socket died before the greeting or halfway through the body.
 *
 * The name is `bytesRead`, not `bytesTransmitted`, and the difference is the bug: it means the
 * COMPOSER ran and something pulled the message out of it, which is NOT the same as the server
 * receiving anything. So it is only ever used in the safe direction: no byte read is proof that
 * nothing went, while a byte read leaves it unknowable, and unknowable resolves to `after-data`.
 */
export function classify(error: unknown, bytesRead: boolean): SmtpError {
  const existing = error as Partial<SmtpError> & { code?: unknown; command?: unknown }
  if (existing && (existing.stage === 'before-data' || existing.stage === 'after-data')) {
    return error as SmtpError
  }
  const rawCode = typeof existing?.code === 'string' ? existing.code : undefined
  const command = typeof existing?.command === 'string' ? existing.command : undefined
  const message = error instanceof Error ? error.message : String(error)
  const provablyBefore = (rawCode !== undefined && PRE_DATA_ONLY_CODES.has(rawCode))
    || (command !== undefined && command.startsWith('AUTH'))
    || (command !== undefined && PRE_DATA_COMMANDS.has(command) && !bytesRead)
  const stage = provablyBefore ? 'before-data' : 'after-data'
  const detail = stage === 'before-data'
    ? `The outgoing mail server refused the message before it accepted any of it. ${message}`
    : `The outgoing mail server stopped answering while the message was being sent, so Walnut `
      + `cannot tell whether it went. ${message}`
  return sendError(codeFor(rawCode), detail, stage)
}

/** `stage` may be a thunk: a timeout's honest stage is only known when the clock fires. */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  stage: 'before-data' | 'after-data' | (() => 'before-data' | 'after-data'),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(sendError(
        'unreachable',
        `${what} within ${ms}ms.`,
        typeof stage === 'function' ? stage() : stage,
      )),
      Math.max(1, ms),
    )
    timer.unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
