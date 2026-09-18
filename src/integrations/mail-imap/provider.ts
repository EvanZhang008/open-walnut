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
  AccountSetupPreset,
  Disposable,
  MailAccount,
  MailBody,
  MailCapabilities,
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
  serverRefusal,
  toProviderError,
  type ImapClient,
  type ImapMailboxInfo,
} from './client.js'
import { accountIdFor, ImapAccountStore, PROVIDER_ID } from './config.js'
import { decodeCursor, decodeMessageId, encodeCursor, mailboxRole } from './coords.js'
import {
  hasTextPart,
  MAX_SOURCE_BYTES,
  parseMime,
  toEnvelope,
} from './mime.js'
import { advanceCursor, hasMore, planPoll } from './poll-range.js'
import { createImapSender } from './provider-send.js'
import { imapPortFor, pastedPassword, SETUP_PRESETS, serverFilesSentCopy, submissionPortFor } from './setup-presets.js'
import { verifySmtp, type SmtpSecurity } from './smtp.js'

/** Headers the ENVELOPE does not carry, or carries in a lossy form. */
const WANTED_HEADERS = ['message-id', 'references', 'in-reply-to', 'date', 'reply-to']

interface ProviderLog {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

function tooLarge(bytes: number) {
  return providerError(
    'too-large',
    `That message is ${Math.round(bytes / 1024)} KB, over the ${MAX_SOURCE_BYTES / 1024} KB cap Walnut will parse.`,
  )
}

/**
 * Is this LIST entry a real folder, or only a name in the hierarchy?
 *
 * `\Noselect` (RFC 3501) and `\NonExistent` (RFC 5258) both mean the same thing to anybody trying to
 * read mail: the name exists so that its children have a parent, and SELECT will refuse it. Gmail
 * ships two of them to every account (`[Gmail]`, and one per label that only exists as a prefix),
 * and Walnut used to store them as ordinary folders, so they appeared in the sidebar as rows nobody
 * could open and the poll loop spent a round trip failing on each one.
 *
 * Missing flags mean KEEP. A server that answers LIST without attributes, or a fake in a test, must
 * not have its whole mailbox list read as unopenable: the cost of keeping one dead row is a failed
 * SELECT that is now handled, and the cost of dropping a real folder is mail that never appears.
 * INBOX is kept whatever the flags say, for the same reason and because it always exists.
 */
function selectable(entry: { path: string; flags?: Iterable<string> }): boolean {
  if (entry.path.toUpperCase() === 'INBOX') return true
  if (!entry.flags) return true
  for (const flag of entry.flags) {
    // Flag names are case-insensitive in IMAP, so the comparison has to be too.
    const name = String(flag).toLowerCase()
    if (name === '\\noselect' || name === '\\nonexistent') return false
  }
  return true
}

/**
 * SELECT one mailbox, translating "the server will not open this one" into `not-found`.
 *
 * Every IMAP account has folders it lists but will not select. Gmail's `[Gmail]` namespace node is
 * one, and so is any label whose only reason to exist is that a nested label lives under it: LIST
 * reports them (RFC 5258 calls them `\Noselect`), SELECT answers `NO`. Without this the refusal was
 * mapped as `unreachable`, which is a claim about the NETWORK, and two mechanisms built for network
 * faults then fired on a healthy connection: the pool dropped the account's socket into a reconnect
 * backoff, and the sweep treated it as this account being down.
 *
 * `not-found` is the code the contract already has for "that container is not there", and both
 * layers above already do the right thing with it: the pool passes it through without touching the
 * connection, and the sync loop marks the container done and moves to the next folder.
 */
async function openMailbox(
  client: Pick<ImapClient, 'mailboxOpen'>,
  path: string,
): Promise<ImapMailboxInfo> {
  try {
    return await client.mailboxOpen(path)
  } catch (error) {
    const refused = serverRefusal(error)
    if (!refused) throw error
    // A NO can also be the SIGN-IN being rejected, and that answer outranks this one: the two send
    // the human to opposite places, and only the credential reading ever asks them for a password.
    // Deciding that is `toProviderError`'s job, so it gets asked first rather than second-guessed.
    const mapped = toProviderError(error, `the folder "${path}"`)
    if (mapped.code === 'auth') throw mapped
    throw providerError(
      'not-found',
      `The mail server will not open the folder "${path}". It answered ${refused.status}`
      + `${refused.text ? `: ${refused.text}` : '.'}`,
    )
  }
}

/**
 * The whole capability block, in one place so the per-account answer can narrow it.
 *
 * `send: true` is a statement about the PROVIDER, not about any one account: this code can send
 * when an account has SMTP settings. `accountCapabilities` is what tells the truth per account,
 * and the base prefers it everywhere a decision is actually made.
 */
const CAPABILITIES: MailCapabilities = {
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
  send: true,
  sendAsReply: true,
  bodies: 'both',
  attachments: 'metadata',
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

  const sender = createImapSender({ store, pool, log, accountOf })

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
    capabilities: CAPABILITIES,

    /**
     * What THIS account can do, which is not always what the provider can.
     *
     * Reading needs a host and a password; sending needs a second server the human may never have
     * filled in. So `send` is per account, and it is answered from config alone: the base calls
     * this on the send path, and opening a connection here would put a network round trip in front
     * of every draft the console lists.
     */
    async accountCapabilities(accountId: string): Promise<MailCapabilities> {
      const entry = await store.entry(accountId)
      const canSend = !!entry?.smtp
      return { ...CAPABILITIES, send: canSend, sendAsReply: canSend }
    },

    setup: {
      // The services most people are actually adding (see SETUP_PRESETS): this form knows their
      // servers, and one that kept that to itself would send the human to look up a hostname it
      // holds. Optional in the contract, so a provider with nothing to declare renders as before.
      presets: SETUP_PRESETS,

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
        // The outgoing half, and every field is OPTIONAL. An account added without them reads
        // mail and reports `send: false`, which is the honest answer and a working account; making
        // them required would mean nobody can add a mailbox they only want to read.
        {
          name: 'smtp_host',
          label: 'Outgoing (SMTP) server',
          kind: 'text',
          placeholder: 'smtp.example.com',
          help: 'Leave blank to add this account for reading only. Walnut hides Send until it is set.',
        },
        { name: 'smtp_port', label: 'Outgoing port', kind: 'text', placeholder: '587' },
        {
          name: 'smtp_tls',
          label: 'Outgoing encryption',
          kind: 'select',
          options: [
            { value: 'starttls', label: 'STARTTLS (port 587)' },
            { value: 'tls', label: 'TLS (port 465)' },
            { value: 'none', label: 'None' },
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
       *
       * SMTP is probed in the SAME budget, and only when the fields were given. An outgoing server
       * that refuses the password is worth finding out about here, while the human is still looking
       * at the form, rather than in a letter whose Send button is guaranteed to fail.
       */
      async submit(values: Record<string, string>): Promise<MailAccount> {
        const address = (values.address ?? '').trim()
        // An app password pasted off a vendor's screen arrives in groups of four. See pastedPassword:
        // only that exact shape is joined up, because a space can be part of a real password.
        const password = pastedPassword(values.password)
        const host = (values.imap_host ?? '').trim()
        const tls = values.imap_tls === 'starttls' ? 'starttls' : 'tls'
        // Blank, or the canonical port of the OTHER encryption, both mean "what this encryption
        // uses". See imapPortFor: a preset fills no port, and switching the encryption after a fill
        // must not submit 993 with STARTTLS.
        const port = imapPortFor(values.imap_port, tls)
        if (!address || !password || !host) {
          throw providerError('invalid', 'An email address, a password and an IMAP server are all required.')
        }
        const smtpHost = (values.smtp_host ?? '').trim()
        const smtpSecurity: SmtpSecurity = values.smtp_tls === 'tls'
          ? 'tls'
          : values.smtp_tls === 'none' ? 'none' : 'starttls'
        const smtpPort = submissionPortFor(values.smtp_port, smtpSecurity)

        const startedAt = Date.now()
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
        if (smtpHost) {
          // ONE budget across both probes, so a setup cannot take 30 seconds by doing two 15s
          // waits. The floor keeps the error legible when IMAP has eaten nearly all of it.
          await verifySmtp({
            settings: { host: smtpHost, port: smtpPort, security: smtpSecurity },
            user: address,
            password,
            timeoutMs: Math.max(2_000, CONNECT_TIMEOUT_MS - (Date.now() - startedAt)),
          })
        }

        // A known service that files its own Sent copy is stamped on the ACCOUNT here, so nobody
        // has to know that about their own mail host: Gmail through smtp.gmail.com would otherwise
        // end up with two copies of every message in Sent.
        const savesSent = serverFilesSentCopy(smtpHost)
        const entry = await store.save({
          address, host, port, tls,
          password,
          displayName: address,
          ...(smtpHost ? { smtpHost, smtpPort, smtpSecurity } : {}),
          ...(typeof savesSent === 'boolean' ? { serverSavesSent: savesSent } : {}),
        })
        log.info('imap account configured', {
          accountId: entry.accountId, host, port, tls, canSend: !!smtpHost,
        })
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
      return listed.filter(selectable).map((one) => ({
        mailboxId: one.path,
        name: one.name ?? one.path,
        role: mailboxRole(one, entry.roles),
        unread: one.status?.unseen ?? 0,
        total: one.status?.messages ?? 0,
      }))
    },

    /**
     * One page of a container, newest first, in a range whose size this provider chose.
     *
     * Every range is bounded at BOTH ends. The reason is the whole of poll-range.ts: an
     * open-ended `1:*` asks the server to stream the entire mailbox, and breaking out of the loop
     * after `limit` messages does not stop it, so a 37,832-message INBOX could never answer inside
     * the run budget and the account's whole tick died with it.
     */
    async poll(accountId: string, request: MailPollRequest): Promise<MailPollResult> {
      const connection = await pool.for(accountId)
      const limit = Math.max(1, Math.min(request.limit || 50, 200))
      return connection.run(`a poll of ${request.mailbox}`, async (client) => {
        const box = await openMailbox(client, request.mailbox)
        const uidValidity = String(box.uidValidity)
        const previous = decodeCursor(request.cursor)
        // A changed UIDVALIDITY voids every UID we hold. Answering `reset` is the contract's way
        // of saying so without the base ever learning what a UID is.
        const reset = !!previous && previous.uidValidity !== uidValidity
        const held = reset || !previous ? undefined : previous
        const exists = Math.max(0, Math.floor(Number(box.exists) || 0))
        // UIDNEXT is what makes a quiet mailbox free: it says whether anything new can exist, so
        // a caught-up container costs a SELECT and no FETCH at all.
        const uidNext = Math.max(0, Math.floor(Number(box.uidNext) || 0))
        const plan = planPoll({ ...(held ? { held } : {}), limit, exists, uidNext })

        const messages: MailEnvelope[] = []
        let lowest = 0
        let highest = 0
        let oldestAt = 0
        if (plan.mode !== 'idle') {
          for await (const message of client.fetch(
            plan.range,
            {
              uid: true, flags: true, envelope: true, bodyStructure: true, size: true,
              internalDate: true, headers: WANTED_HEADERS,
            },
            { uid: plan.byUid },
          )) {
            // The bounds are in the request now, but a server is still free to answer with more
            // than was asked for, and `n:*` (which nothing here sends any more) always answered
            // with the newest message even when nothing was at or above n.
            if (plan.mode === 'newer' && message.uid <= (held?.lastUid ?? 0)) continue
            messages.push(toEnvelope(request.mailbox, uidValidity, message))
            if (message.uid > highest) highest = message.uid
            if (lowest === 0 || message.uid < lowest) lowest = message.uid
            const at = message.internalDate ? new Date(message.internalDate).getTime() : 0
            if (Number.isFinite(at) && at > 0 && (oldestAt === 0 || at < oldestAt)) oldestAt = at
            if (messages.length >= limit) break
          }
        }

        const next = advanceCursor({
          plan,
          ...(held ? { held } : {}),
          page: { lowest, highest, oldestAt },
          since: Math.max(0, Math.floor(Number(request.since) || 0)),
        })
        // Numbers only, never a subject or an address. The FIRST page of a container is the one
        // worth a line everybody can see: it is where the window comes from, it happens once per
        // container per epoch, and reconstructing it afterwards from cached rows is guesswork
        // (the guess was wrong once, which is why this line exists). Every other page stays at
        // debug, where a per-page line for 67 mailboxes cannot drown the log.
        const page = {
          accountId,
          mailbox: request.mailbox,
          exists,
          uidNext,
          mode: plan.mode,
          ...(plan.mode !== 'idle' ? { range: plan.range, byUid: plan.byUid } : {}),
          got: messages.length,
          heldCursor: request.cursor ?? null,
          cursor: encodeCursor(uidValidity, next.lastUid, next.floorUid),
        }
        if (plan.mode === 'newest' || reset) log.info('imap opened a container', page)
        else log.debug('imap polled a page', page)
        return {
          messages,
          cursor: encodeCursor(uidValidity, next.lastUid, next.floorUid),
          more: plan.mode !== 'idle' && hasMore(next, uidNext, messages.length >= limit),
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
        await openMailbox(client, coord.mailbox)
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
        await openMailbox(client, coord.mailbox)
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

    /**
     * One SMTP attempt, and an honest `stage` on the way out.
     *
     * Everything about whether this may be retried is decided in `smtp.ts`; this function's job is
     * to refuse early when the account cannot send at all, hand over the message the base composed,
     * and then file the Sent copy without letting that step touch the outcome.
     */
    /**
     * Send one message. The outgoing half lives in provider-send.ts.
     *
     * Everything interesting about it is a deadline argument, so it is written out where it can be
     * read next to the numbers it depends on rather than in the middle of the read path.
     */
    send: sender.send,

    async removeAccount(accountId: string): Promise<void> {
      await pool.forget(accountId)
      await store.remove(accountId)
    },
  }
}
