/**
 * Local typings for `nodemailer`, covering exactly the surface the send path uses.
 *
 * Why not `@types/nodemailer`: it is a large hand-maintained surface for a library we touch in
 * one file and through five members, and the two are versioned independently, so it is both more
 * to justify and a shape that can drift from the code actually running. Declaring what we call
 * fails loudly here if the library ever changes it.
 *
 * `use('stream', ...)` and `message.transform()` are the interesting pair, and the reason to be
 * careful with them. The transform sees the composed message, which is exactly what a Sent-folder
 * copy should hold, so the send path taps it for those bytes. It is NOT a "DATA has begun" signal,
 * however tempting that reading is: `smtp-connection.send()` pipes the whole message into a
 * throwaway stream on the envelope-error path purely to avoid holding it in memory, so the
 * transform also drains for a refused recipient. Whether a failure may be retried is decided from
 * `err.command` and `err.code` instead (see `classify` in smtp.ts).
 *
 * Errors from `sendMail` therefore carry more than a message: `code` (EAUTH, EENVELOPE, EMESSAGE,
 * ESOCKET, ETIMEDOUT, ...), `command` (the protocol position: CONN, EHLO, AUTH PLAIN, MAIL FROM,
 * RCPT TO, DATA, or API for a local refusal) and `responseCode` when the server gave a number.
 */
declare module 'nodemailer' {
  import type { Transform } from 'node:stream'

  interface Address {
    name?: string
    address: string
  }

  interface SendMailOptions {
    from?: Address | string
    to?: Array<Address | string>
    cc?: Array<Address | string>
    bcc?: Array<Address | string>
    subject?: string
    text?: string
    html?: string
    inReplyTo?: string
    references?: string[] | string
    messageId?: string
    date?: Date
    headers?: Record<string, string>
  }

  interface SentMessageInfo {
    messageId?: string
    accepted?: string[]
    rejected?: string[]
    /** The server's reply to the end of DATA. Present means the message was accepted. */
    response?: string
    envelope?: { from: string; to: string[] }
  }

  /** The composed message, as a `stream` plugin sees it. */
  interface ComposedMessage {
    transform(supplier: () => Transform): void
  }

  interface PluginMail {
    message?: ComposedMessage
  }

  interface Transporter {
    sendMail(mail: SendMailOptions): Promise<SentMessageInfo>
    /** Connect and authenticate, sending nothing. What the setup probe uses. */
    verify(): Promise<boolean>
    close(): void
    use(step: string, plugin: (mail: PluginMail, callback: (error?: Error) => void) => void): unknown
  }

  interface TransportOptions {
    host: string
    port: number
    secure: boolean
    requireTLS?: boolean
    ignoreTLS?: boolean
    auth?: { user: string; pass: string }
    pool?: boolean
    logger?: boolean
    connectionTimeout?: number
    greetingTimeout?: number
    socketTimeout?: number
    tls?: { rejectUnauthorized?: boolean }
  }

  function createTransport(options: TransportOptions): Transporter
}
