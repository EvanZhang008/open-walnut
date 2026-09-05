/**
 * The IMAP provider: the whole `MailProviderSpec`, and nothing about mail as a domain.
 *
 * It knows UIDs, UIDVALIDITY, SPECIAL-USE and BODYSTRUCTURE. It knows nothing about the cache,
 * retention, threads, drafts or events, because those belong to the base and every provider gets
 * them for free by staying out of them.
 *
 * Three transport facts that shape the code, each one a bug if forgotten:
 *
 * - `UID <n>:*` returns AT LEAST ONE message even when no UID is >= n, because `*` is the
 *   highest existing UID and IMAP will not answer an empty range. Every fetch below filters
 *   `uid > lastUid` for that reason; without it a quiet mailbox re-reports its newest message on
 *   every single poll.
 * - A UID means nothing without UIDVALIDITY. When the server changes it, every UID we stored is
 *   void, so the cursor carries it and a mismatch answers `reset: true`, which is the contract's
 *   way of saying "resync this container".
 * - A mailbox name is nearly arbitrary text, so the message handle is parsed from the right
 *   (see coords.ts) and a mailbox called "Projects/2026: old" round-trips.
 */
import type {
  Disposable,
  MailAccount,
  MailBody,
  MailEnvelope,
  MailPollRequest,
  MailPollResult,
  MailProviderSpec,
  MailWatchHint,
  Mailbox,
  ProviderHealth,
} from '../mail/api.js'
import {
  CONNECT_TIMEOUT_MS,
  ImapConnection,
  ImapPool,
  providerError,
  toProviderError,
  type ImapFetchedMessage,
} from './client.js'
import { accountIdFor, ImapAccountStore, PROVIDER_ID } from './config.js'
import { decodeCursor, decodeMessageId, encodeCursor, encodeMessageId, mailboxRole } from './coords.js'
import {
  attachmentsFromStructure,
  hasTextPart,
  MAX_SOURCE_BYTES,
  messageIdList,
  parseHeaders,
  parseMime,
} from './mime.js'

/** Headers the ENVELOPE does not carry, or carries in a lossy form. */
const WANTED_HEADERS = ['message-id', 'references', 'in-reply-to', 'date']

interface ProviderLog {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

function firstAddress(list: Array<{ name?: string; address?: string }> | undefined) {
  const first = list?.[0]
  return {
    ...(first?.name ? { name: first.name } : {}),
    address: first?.address ?? '',
  }
}

function addressList(list: Array<{ name?: string; address?: string }> | undefined) {
  return (list ?? [])
    .filter((one) => !!one.address)
    .map((one) => ({ ...(one.name ? { name: one.name } : {}), address: one.address! }))
}

function tooLarge(bytes: number) {
  return providerError(
    'too-large',
    `That message is ${Math.round(bytes / 1024)} KB, over the ${MAX_SOURCE_BYTES / 1024} KB cap Walnut will parse.`,
  )
}

function millis(value: Date | string | undefined): number | undefined {
  if (!value) return undefined
  const at = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

function toEnvelope(mailbox: string, uidValidity: string, message: ImapFetchedMessage): MailEnvelope {
  const headers = parseHeaders(message.headers)
  const received = millis(message.internalDate)
  const sentAt = millis(message.envelope?.date) ?? received ?? 0
  const references = messageIdList(headers.references)
  const inReplyTo = messageIdList(headers['in-reply-to'])[0] ?? message.envelope?.inReplyTo
  return {
    messageId: encodeMessageId(mailbox, uidValidity, message.uid),
    rfcMessageId: message.envelope?.messageId ?? headers['message-id'] ?? '',
    mailboxId: mailbox,
    from: firstAddress(message.envelope?.from),
    to: addressList(message.envelope?.to),
    ...(message.envelope?.cc?.length ? { cc: addressList(message.envelope.cc) } : {}),
    subject: message.envelope?.subject ?? '',
    // Epoch milliseconds plus the header verbatim: mail dates are instants, and the header is
    // the only record of what the sender's clock and offset actually said.
    sentAt,
    ...(headers.date ? { sentAtHeader: headers.date } : {}),
    ...(received !== undefined ? { receivedAt: received } : {}),
    flags: [...(message.flags ?? [])],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    attachments: attachmentsFromStructure(message.bodyStructure),
    ...(typeof message.size === 'number' ? { bodyBytes: message.size } : {}),
  }
}

export function createImapProvider(deps: {
  store: ImapAccountStore
  pool: ImapPool
  log: ProviderLog
}): MailProviderSpec {
  const { store, pool, log } = deps

  const accountOf = async (accountId: string) => {
    const entry = await store.entry(accountId)
    if (!entry) throw providerError('not-found', `No IMAP account "${accountId}" is configured on this box.`)
    return entry
  }

  const toAccount = (entry: { accountId: string; settings: { address: string }; displayName: string }): MailAccount => ({
    accountId: entry.accountId,
    providerId: PROVIDER_ID,
    displayName: entry.displayName,
    address: entry.settings.address,
    state: pool.health(entry.accountId)?.state === 'auth-required' ? 'auth-required' : 'active',
    ...(pool.health(entry.accountId) ? { health: pool.health(entry.accountId)! } : {}),
  })

  return {
    id: PROVIDER_ID,
    label: 'IMAP',
    capabilities: {
      // Cache search in v1: IMAP SEARCH is per mailbox, unsorted, and slow on a big folder, and
      // the base's FTS index already covers full body text.
      search: false,
      // Declared true, enforced at watch time. A capability is data the base reads before any
      // connection exists, so IDLE cannot be probed here; `watch` returns a no-op handle and
      // logs when the server turns out not to advertise it, which degrades to poll-only.
      watch: true,
      drafts: false,
      markRead: true,
      flags: false,
      threads: false,
      // Sending is P2-2. `send` below refuses rather than silently doing nothing.
      send: false,
      sendAsReply: false,
      bodies: 'both',
      attachments: 'metadata',
    },

    setup: {
      fields: [
        { name: 'address', label: 'Email address', kind: 'text', required: true, placeholder: 'you@example.com' },
        {
          name: 'password',
          label: 'Password',
          kind: 'password',
          required: true,
          help: 'Use an app password, never your main account password. Most providers issue one per app.',
        },
        { name: 'imap_host', label: 'IMAP server', kind: 'text', required: true, placeholder: 'imap.example.com' },
        { name: 'imap_port', label: 'Port', kind: 'text', placeholder: '993' },
        {
          name: 'imap_tls',
          label: 'Encryption',
          kind: 'select',
          options: [
            { value: 'tls', label: 'TLS (port 993)' },
            { value: 'starttls', label: 'STARTTLS (port 143)' },
          ],
        },
      ],

      /**
       * Prove the credential, THEN store it.
       *
       * The probe is a throwaway connection built from the submitted values, not from config, so
       * a wrong password never lands on disk and a failed setup leaves nothing behind. The LIST
       * is what proves authentication: a server can accept a TCP connection and a greeting from
       * anyone, and only a real command proves the login went through.
       */
      async submit(values: Record<string, string>): Promise<MailAccount> {
        const address = (values.address ?? '').trim()
        const password = values.password ?? ''
        const host = (values.imap_host ?? '').trim()
        const tls = values.imap_tls === 'starttls' ? 'starttls' : 'tls'
        const port = Number(values.imap_port) || (tls === 'starttls' ? 143 : 993)
        if (!address || !password || !host) {
          throw providerError('invalid', 'An email address, a password and an IMAP server are all required.')
        }

        const probe = new ImapConnection({
          accountId: accountIdFor(address),
          settings: { address, host, port, tls },
          password: async () => password,
          log,
          commandTimeoutMs: CONNECT_TIMEOUT_MS,
        })
        try {
          await probe.run('a mailbox list', (client) => client.list(), CONNECT_TIMEOUT_MS)
        } finally {
          await probe.dispose().catch(() => undefined)
        }

        const entry = await store.save({
          address, host, port, tls,
          password,
          displayName: address,
        })
        log.info('imap account configured', { accountId: entry.accountId, host, port, tls })
        return {
          accountId: entry.accountId,
          providerId: PROVIDER_ID,
          displayName: entry.displayName,
          address,
          state: 'active',
          health: { state: 'ok', checkedAt: Date.now() },
        }
      },
    },

    async listAccounts(): Promise<MailAccount[]> {
      return (await store.list()).map(toAccount)
    },

    /** The live connection's last outcome, or one real probe when there is no connection yet. */
    async health(accountId: string): Promise<ProviderHealth> {
      const known = pool.health(accountId)
      if (known && known.checkedAt > 0) return known
      try {
        const connection = await pool.for(accountId)
        // The DEFAULT budget, not the setup probe's: this is a read a console triggers, and it has
        // to answer inside the base's own provider deadline rather than at the edge of it.
        await connection.run('a mailbox list', (client) => client.list())
        return { state: 'ok', checkedAt: Date.now() }
      } catch (error) {
        const mapped = toProviderError(error, `account ${accountId}`)
        return {
          state: mapped.code === 'auth' ? 'auth-required' : 'unreachable',
          checkedAt: Date.now(),
          detail: mapped.message.slice(0, 300),
        }
      }
    },

    async listMailboxes(accountId: string): Promise<Mailbox[]> {
      const entry = await accountOf(accountId)
      const connection = await pool.for(accountId)
      // STATUS per mailbox costs a round trip each, which is why the base re-lists mailboxes
      // every fifth tick rather than every tick.
      const listed = await connection.run(
        'a mailbox list',
        (client) => client.list({ statusQuery: { messages: true, unseen: true } }),
      )
      return listed.map((one) => ({
        mailboxId: one.path,
        name: one.name ?? one.path,
        role: mailboxRole(one, entry.roles),
        unread: one.status?.unseen ?? 0,
        total: one.status?.messages ?? 0,
      }))
    },

    async poll(accountId: string, request: MailPollRequest): Promise<MailPollResult> {
      const connection = await pool.for(accountId)
      const limit = Math.max(1, Math.min(request.limit || 50, 200))
      return connection.run(`a poll of ${request.mailbox}`, async (client) => {
        const box = await client.mailboxOpen(request.mailbox)
        const uidValidity = String(box.uidValidity)
        const previous = decodeCursor(request.cursor)
        // A changed UIDVALIDITY voids every UID we hold. Answering `reset` is the contract's way
        // of saying so without the base ever learning what a UID is.
        const reset = !!previous && previous.uidValidity !== uidValidity
        const lastUid = reset || !previous ? 0 : previous.lastUid

        const messages: MailEnvelope[] = []
        let highest = lastUid
        for await (const message of client.fetch(
          `${lastUid + 1}:*`,
          {
            uid: true, flags: true, envelope: true, bodyStructure: true, size: true,
            internalDate: true, headers: WANTED_HEADERS,
          },
          { uid: true },
        )) {
          // `n:*` answers with the newest message even when nothing is at or above n. Without
          // this line a quiet mailbox re-reports the same message on every poll, forever.
          if (message.uid <= lastUid) continue
          messages.push(toEnvelope(request.mailbox, uidValidity, message))
          if (message.uid > highest) highest = message.uid
          if (messages.length >= limit) break
        }

        return {
          messages,
          cursor: encodeCursor(uidValidity, highest),
          // The page filled, so there may be more behind it. Saying `false` here would leave a
          // backfill stuck at one page per tick.
          more: messages.length >= limit,
          ...(reset ? { reset: true } : {}),
        }
      })
    },

    /**
     * The raw source, refused above the cap, parsed once.
     *
     * The size is checked from the FETCH response before anything is parsed, and the source
     * itself is requested with a maxLength so a 50 MB message never lands in this process's
     * heap even for the instant it takes to reject it.
     */
    async getBody(accountId: string, messageId: string, sizeHint?: number): Promise<MailBody> {
      const coord = decodeMessageId(messageId)
      if (!coord) throw providerError('invalid', `"${messageId}" is not an IMAP message handle.`)
      // Refused from the hint the POLL already reported, before a byte moves. Checking only after
      // the fetch meant downloading up to the cap to discover the message is over it, which is
      // the entire cost the cap exists to avoid, once per read attempt.
      if (sizeHint !== undefined && sizeHint > MAX_SOURCE_BYTES) throw tooLarge(sizeHint)
      const connection = await pool.for(accountId)
      const fetched = await connection.run(`a body for ${messageId}`, async (client) => {
        await client.mailboxOpen(coord.mailbox)
        return client.fetchOne(
          String(coord.uid),
          // `bodyStructure` rides along in the SAME fetch: it is the server's own parse of these
          // bytes and it is the only reliable way to know whether the message really had a plain
          // text part (see hasTextPart). No extra round trip.
          { uid: true, size: true, bodyStructure: true, source: { maxLength: MAX_SOURCE_BYTES } },
          { uid: true },
        )
      })
      if (!fetched) throw providerError('not-found', `Message ${messageId} is no longer in ${coord.mailbox}.`)
      if (fetched.size !== undefined && fetched.size > MAX_SOURCE_BYTES) throw tooLarge(fetched.size)
      if (!fetched.source) throw providerError('not-found', `The mail server returned no source for ${messageId}.`)
      // No RFC822.SIZE from the server, and the source arrived at exactly the maxLength we asked
      // for: that is what a truncated download looks like, and there is no way to tell it from a
      // message that happens to be exactly 2 MB. Parsing it would hand back the first 2 MB of a
      // 50 MB message labelled complete, so it is refused.
      if (fetched.size === undefined && fetched.source.byteLength >= MAX_SOURCE_BYTES) {
        throw tooLarge(fetched.source.byteLength)
      }
      const size = fetched.size ?? fetched.source.byteLength
      const parsed = await parseMime(fetched.source)
      // Labelled by what the SOURCE carried, per the server's structure, falling back to the
      // parse only when there is no structure to read. mailparser synthesizes `text` from HTML
      // when there is no plain part, so trusting `parsed.text` reported html-only mail as
      // `'both'`. The synthesized text is still kept and still indexed: it is useful for search,
      // it is just not evidence that the sender wrote a text part.
      const hadText = hasTextPart(fetched.bodyStructure) ?? !!parsed.text
      return {
        format: hadText && parsed.html ? 'both' : parsed.html ? 'html' : 'text',
        ...(parsed.text ? { text: parsed.text } : {}),
        ...(parsed.html ? { html: parsed.html } : {}),
        bytes: size,
        ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
      }
    },

    async markRead(accountId: string, messageId: string, read: boolean): Promise<void> {
      const coord = decodeMessageId(messageId)
      if (!coord) throw providerError('invalid', `"${messageId}" is not an IMAP message handle.`)
      const connection = await pool.for(accountId)
      await connection.run(`a read flag for ${messageId}`, async (client) => {
        await client.mailboxOpen(coord.mailbox)
        return read
          ? client.messageFlagsAdd(String(coord.uid), ['\\Seen'], { uid: true })
          : client.messageFlagsRemove(String(coord.uid), ['\\Seen'], { uid: true })
      })
    },

    /**
     * IDLE on INBOX, armed in the background.
     *
     * The contract wants a Disposable synchronously while arming needs a connection, so the
     * handle comes back straight away and the arming runs behind it. The hint callback itself
     * does NO I/O: the base flips a dirty flag and kicks its own poll loop, which is the one
     * fetch path both push and poll go through.
     */
    watch(accountId: string, onHint: (hint: MailWatchHint) => void): Disposable {
      let disposed = false
      let armed: ImapConnection | null = null
      void (async () => {
        const connection = await pool.for(accountId)
        if (disposed) return
        armed = connection
        // `watchInbox` re-SELECTs INBOX before it listens, so INBOX is genuinely the mailbox the
        // hint is about. It used to say INBOX while IDLE ran on whatever the last poll left open.
        await connection.watchInbox(() => onHint({ mailbox: 'INBOX' }))
      })().catch((error: unknown) => {
        log.debug('imap watch could not be armed, staying poll-only', {
          accountId, error: String(error).slice(0, 200),
        })
      })
      return {
        dispose: () => {
          disposed = true
          armed?.unwatch()
        },
      }
    },

    /** P2-2. Declared `send: false`, and this refuses rather than looking like it worked. */
    async send(): Promise<never> {
      throw providerError('unsupported', 'Sending mail arrives in a later slice; this provider reads only.')
    },

    async removeAccount(accountId: string): Promise<void> {
      await pool.forget(accountId)
      await store.remove(accountId)
    },
  }
}
