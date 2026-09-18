/**
 * The IMAP connection: one per account, serialized, and never able to hang a caller.
 *
 * IMAP is a stateful, single-command-at-a-time protocol over a long-lived socket, and every
 * rule in this file follows from that:
 *
 * - ONE connection per account, and commands run ONE AT A TIME through `run`. A second command
 *   interleaved with a `SELECT` reads the wrong mailbox, which is a data bug rather than an
 *   error, so the serialization is not an optimization.
 * - EVERY command has a deadline. A TCP socket to a machine that went away does not error, it
 *   goes quiet, so without a deadline a poll waits forever and the account never syncs again.
 *   A timeout is reported as `unreachable`, which is the honest reading.
 * - A wrong password is `auth` and is NOT retried. Retrying credentials on a schedule is how an
 *   account gets locked out; the base parks the account and asks the human instead.
 * - The password never reaches a log line. It is read per connect and handed to the transport.
 *
 * `imapflow` is loaded lazily and behind a factory, so a process that never opens a mailbox
 * never loads it, and a test can hand in a fake class instead of a socket.
 */
import type { ProviderHealth, ProviderErrorCode } from '../mail/api.js'

/**
 * ONE budget per `run`, covering the connect AND the command.
 *
 * Not two. With a 15s connect and a 10s command a single call could legitimately take 25s, while
 * the base's own `callProvider` gives up at 15s: the caller was gone, the abandoned command still
 * held the connection's gate, and every later command queued behind a request nobody was waiting
 * for. 12s keeps a whole `run` inside the base's budget.
 */
export const RUN_BUDGET_MS = 12_000

/** The setup probe's total: a cold connect plus a LIST, and no more. */
export const CONNECT_TIMEOUT_MS = 15_000

const MIN_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 60_000

export interface ImapAccountSettings {
  address: string
  host: string
  port: number
  /** `tls` connects with TLS from the first byte; `starttls` upgrades a plain connection. */
  tls: 'tls' | 'starttls'
}

export interface ImapMailboxInfo {
  path: string
  uidValidity: bigint | number | string
  uidNext?: number
  exists?: number
  unseen?: number
}

export interface ImapListEntry {
  path: string
  name?: string
  specialUse?: string
  flags?: Iterable<string>
  status?: { messages?: number; unseen?: number }
}

export interface ImapEnvelopeInfo {
  date?: Date
  subject?: string
  messageId?: string
  inReplyTo?: string
  from?: Array<{ name?: string; address?: string }>
  to?: Array<{ name?: string; address?: string }>
  cc?: Array<{ name?: string; address?: string }>
}

export interface ImapFetchedMessage {
  uid: number
  size?: number
  flags?: Set<string> | string[]
  envelope?: ImapEnvelopeInfo
  bodyStructure?: unknown
  internalDate?: Date | string
  headers?: Buffer | string
  source?: Buffer
}

/**
 * The slice of `ImapFlow` this provider uses, restated structurally.
 *
 * Deliberately not `import type { ImapFlow }`: the point is that a test can pass a hand-written
 * class, and a structural interface is also the honest documentation of how much of the library
 * we actually depend on.
 */
export interface ImapClient {
  usable?: boolean
  capabilities?: Map<string, unknown> | Set<string> | string[]
  connect(): Promise<void>
  logout(): Promise<void>
  close?(): void
  list(options?: unknown): Promise<ImapListEntry[]>
  mailboxOpen(path: string, options?: unknown): Promise<ImapMailboxInfo>
  fetch(range: string, query: unknown, options?: unknown): AsyncIterable<ImapFetchedMessage>
  fetchOne(range: string, query: unknown, options?: unknown): Promise<ImapFetchedMessage | false>
  messageFlagsAdd(range: string, flags: string[], options?: unknown): Promise<boolean>
  messageFlagsRemove(range: string, flags: string[], options?: unknown): Promise<boolean>
  /**
   * Put a message INTO a mailbox. The only write this provider makes that is not a flag.
   *
   * Used for the Sent copy: SMTP delivers the message and says nothing to IMAP, so unless the
   * outgoing server files its own copy, the Sent folder stays empty until someone APPENDs the
   * bytes. `date` is the message's own Date header, so the copy sorts where the human expects.
   */
  append(path: string, content: Buffer | string, flags?: string[], date?: Date): Promise<unknown>
  on(event: string, listener: (payload: unknown) => void): unknown
  removeAllListeners?(event?: string): unknown
}

export interface ImapConnectOptions {
  host: string
  port: number
  secure: boolean
  auth: { user: string; pass: string }
  logger: false
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

export type ImapClientFactory = (options: ImapConnectOptions) => Promise<ImapClient>

let factory: ImapClientFactory = async (options) => {
  const { ImapFlow } = await import('imapflow')
  return new ImapFlow(options) as unknown as ImapClient
}

/** Test seam: a fake class instead of a socket. Pass `null` to restore the real one. */
export function setImapClientFactory(fake: ImapClientFactory | null): void {
  factory = fake ?? (async (options) => {
    const { ImapFlow } = await import('imapflow')
    return new ImapFlow(options) as unknown as ImapClient
  })
}

export interface ImapError extends Error {
  code: ProviderErrorCode
}

export function providerError(code: ProviderErrorCode, message: string): ImapError {
  const error = new Error(message) as ImapError
  error.code = code
  return error
}

/**
 * Only ever applied to a server RESPONSE, never to a raw transport error.
 *
 * `getaddrinfo ENOTFOUND imap.authsmtp.com` contains "auth" and used to park the account as a
 * wrong password, sending the user to change a credential that was fine while their DNS was
 * broken. The bare `auth` and `password` alternatives are gone for the same reason: a hostname, a
 * path or a proxy banner can contain either word.
 */
const AUTH_RESPONSE_PATTERN = /\b(?:authentication (?:failed|error)|invalid credentials|login failed|invalid (?:user|username|password)|bad credentials)\b/i

/**
 * What the server said when it REFUSED a command, or null for anything else.
 *
 * imapflow answers a tagged `NO` or `BAD` with `new Error('Command failed')` and hangs the useful
 * part off the error: `responseStatus` is the word the server used and `responseText` is its own
 * explanation. Telling this apart from a transport failure matters twice over, because the two need
 * opposite handling: a refusal is an answer, so the connection is fine and must be kept, while
 * "unreachable" tears the connection down and arms a reconnect backoff. Reporting one as the other
 * turned a single unopenable folder into an account-wide stall every ten minutes.
 */
export function serverRefusal(error: unknown): { status: 'NO' | 'BAD'; text: string } | null {
  const raw = error as { responseStatus?: unknown; responseText?: unknown } | null
  const status = typeof raw?.responseStatus === 'string' ? raw.responseStatus.toUpperCase() : ''
  if (status !== 'NO' && status !== 'BAD') return null
  return { status, text: typeof raw?.responseText === 'string' ? raw.responseText : '' }
}

/**
 * A transport failure as one of the contract's codes.
 *
 * Only two outcomes are worth distinguishing to the human: the credential is wrong, or the
 * server could not be reached. Everything else (a reset socket, DNS, a TLS mismatch, our own
 * deadline) is `unreachable`, because the user's next action is the same in all of them.
 *
 * The server's OWN WORDS ride along whenever it gave any. `Error('Command failed')` is all imapflow
 * puts in `message`, so a real refusal ("Unable to open this folder", a quota, a disabled mailbox)
 * reached the log as five characterless words and every diagnosis had to start from scratch.
 */
export function toProviderError(error: unknown, what: string): ImapError {
  const raw = error as {
    code?: unknown
    authenticationFailed?: boolean
    responseText?: unknown
    response?: unknown
    serverResponseCode?: unknown
  } | null
  const existing = raw?.code
  if (existing === 'auth' || existing === 'unreachable' || existing === 'too-large' || existing === 'not-found') {
    return error as ImapError
  }
  const message = error instanceof Error ? error.message : String(error)
  // What the SERVER said, in order of how much it can be argued with: the library's own flag, its
  // error code, an AUTHENTICATIONFAILED response code, and only then the response text.
  const response = [raw?.responseText, raw?.response, raw?.serverResponseCode]
    .filter((one): one is string => typeof one === 'string')
    .join(' ')
  const claimed = raw?.authenticationFailed === true
    || existing === 'AuthenticationFailed'
    || /AUTHENTICATIONFAILED/i.test(response)
    // The strict phrase list is applied to the message too, so a transport that only throws
    // `Error('LOGIN failed')` is still read correctly. It is safe there precisely because the
    // bare `auth` and `password` alternatives are gone: nothing in this list appears in a DNS or
    // socket error, while `/auth/i` matched the hostname in `ENOTFOUND imap.authsmtp.com`.
    || AUTH_RESPONSE_PATTERN.test(`${response} ${message}`)
  if (claimed) {
    return providerError('auth', `The mail server rejected the sign-in for ${what}. ${message}`)
  }
  const refusal = serverRefusal(error)
  // `${message}` first, then what the server actually said, so the shape of the line is unchanged
  // for every caller that already reads it and the added words are strictly extra.
  const said = refusal ? ` The server answered ${refusal.status}${refusal.text ? `: ${refusal.text}` : '.'}` : ''
  return providerError('unreachable', `The mail server could not be reached for ${what}. ${message}${said}`)
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(providerError('unreachable', `The mail server did not answer ${what} within ${ms}ms.`)),
      Math.max(1, ms),
    )
    timer.unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function hasCapability(client: ImapClient, name: string): boolean {
  const capabilities = client.capabilities
  if (!capabilities) return false
  const wanted = name.toUpperCase()
  if (capabilities instanceof Map) {
    for (const key of capabilities.keys()) if (String(key).toUpperCase() === wanted) return true
    return false
  }
  if (capabilities instanceof Set) {
    for (const key of capabilities) if (String(key).toUpperCase() === wanted) return true
    return false
  }
  return capabilities.some((key) => String(key).toUpperCase() === wanted)
}

interface ConnectionLog {
  debug(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export class ImapConnection {
  private client: ImapClient | null = null
  private connecting: Promise<ImapClient> | null = null
  private gate: Promise<unknown> = Promise.resolve()
  private failures = 0
  private nextAttemptAt = 0
  private idle = false
  private hint: (() => void) | null = null
  private lastHealth: ProviderHealth = { state: 'degraded', checkedAt: 0, detail: 'not connected yet' }
  private disposed = false

  constructor(private readonly options: {
    accountId: string
    settings: ImapAccountSettings
    password: () => Promise<string | undefined>
    log: ConnectionLog
    commandTimeoutMs?: number
  }) {}

  get health(): ProviderHealth {
    return this.lastHealth
  }

  /** Whether the connected server advertised IDLE. False until the first connect. */
  get supportsIdle(): boolean {
    return this.idle
  }

  /**
   * Run one command against the connection, serialized and under a deadline.
   *
   * The gate makes every caller wait its turn, so a poll and a body fetch in the same tick
   * cannot interleave a SELECT with a FETCH. The deadline covers the command only: the connect
   * has its own, so a cold connection plus a slow command cannot silently take 25 seconds under
   * one 10 second budget.
   */
  run<T>(what: string, work: (client: ImapClient) => Promise<T>, budgetMs?: number): Promise<T> {
    const total = budgetMs ?? this.options.commandTimeoutMs ?? RUN_BUDGET_MS
    const turn = this.gate.catch(() => undefined).then(async () => {
      if (this.disposed) throw providerError('unreachable', 'the mail connection is closed')
      // ONE deadline for the whole turn. The connect spends from the same budget the command
      // does, so a cold socket plus a slow FETCH cannot add up past what the caller allowed.
      const startedAt = Date.now()
      const client = await withDeadline(this.ensureClient(), total, `a connection for ${what}`)
      try {
        return await withDeadline(work(client), total - (Date.now() - startedAt), what)
      } catch (error) {
        throw await this.fail(error, what)
      }
    })
    this.gate = turn.catch(() => undefined)
    return turn
  }

  /**
   * Arm an IDLE watch on INBOX.
   *
   * The listener does NO I/O: it calls the hint and returns. imapflow enters IDLE by itself
   * whenever no command is in flight, so keeping the connection open is all that is needed, and
   * the base's poll loop is what actually fetches after a hint.
   */
  async watchInbox(onHint: () => void): Promise<boolean> {
    await this.run('an IDLE watch', async (connected) => connected)
    if (!this.idle) {
      this.options.log.debug('imap server does not advertise IDLE, staying poll-only', {
        accountId: this.options.accountId,
      })
      return false
    }
    // Stored BEFORE arming, because `connect()` is what attaches the listener and a reconnect can
    // happen at any moment. A socket that drops and comes back used to lose the watch silently:
    // the listener was bound to the dead client, the fresh ImapFlow had none, and the account
    // quietly degraded to poll-only for the life of the process with nothing in the logs.
    this.hint = onHint
    await this.armIdle()
    return true
  }

  /**
   * Open INBOX so the server has something to report on, and listen.
   *
   * Through the gate like any other command, so it cannot interleave with a poll's SELECT. The
   * SELECT matters: IDLE reports on the currently selected mailbox, so without re-selecting here
   * a hint would be about whatever the last poll happened to leave open.
   */
  private async armIdle(): Promise<void> {
    await this.run('an INBOX open for IDLE', (connected) => {
      connected.on('exists', () => {
        // Synchronous by construction: a flag and a kick, on the transport's own stack.
        this.hint?.()
      })
      return connected.mailboxOpen('INBOX')
    })
  }

  unwatch(): void {
    this.hint = null
    this.client?.removeAllListeners?.('exists')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unwatch()
    const client = this.client
    this.client = null
    this.connecting = null
    if (!client) return
    // Logout is polite and bounded; a server that will not answer it gets the socket closed.
    await withDeadline(client.logout(), 2_000, 'a logout').catch(() => {
      try { client.close?.() }
      catch { /* already gone */ }
    })
  }

  private async ensureClient(): Promise<ImapClient> {
    if (this.client && this.client.usable !== false) return this.client
    if (this.connecting) return this.connecting
    if (Date.now() < this.nextAttemptAt) {
      // Refused fast rather than delayed: the caller has a deadline of its own, and the base's
      // per-account backoff is what paces the retries. This only stops a burst of commands in
      // one tick from each opening a fresh socket to a host that is down.
      throw providerError(
        'unreachable',
        `The mail server for ${this.options.accountId} is not reachable; waiting `
        + `${this.nextAttemptAt - Date.now()}ms before trying again.`,
      )
    }
    const attempt = this.connect()
    this.connecting = attempt
    try {
      return await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = null
    }
  }

  private async connect(): Promise<ImapClient> {
    const password = await this.options.password()
    if (!password) {
      this.lastHealth = { state: 'auth-required', checkedAt: Date.now(), detail: 'no stored password' }
      throw providerError(
        'auth',
        `No password is stored for ${this.options.settings.address}. Add the account again to store one.`,
      )
    }
    const { settings } = this.options
    const client = await factory({
      host: settings.host,
      port: settings.port,
      secure: settings.tls === 'tls',
      auth: { user: settings.address, pass: password },
      // The library's own logger would print command traces including the LOGIN line.
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: 5 * 60_000,
    })
    // Attached before connect: an 'error' with no listener on an EventEmitter takes the process
    // down, and a socket can fail at any moment, not only during a command.
    client.on('error', (payload) => {
      this.options.log.warn('imap connection error', {
        accountId: this.options.accountId,
        error: String((payload as { message?: string } | null)?.message ?? payload).slice(0, 200),
      })
      if (this.client === client) this.client = null
    })
    client.on('close', () => {
      if (this.client === client) this.client = null
    })
    try {
      await withDeadline(client.connect(), CONNECT_TIMEOUT_MS, 'a connection')
    } catch (error) {
      try { client.close?.() }
      catch { /* nothing to close */ }
      throw await this.fail(error, `a connection to ${settings.host}`)
    }
    this.client = client
    this.idle = hasCapability(client, 'IDLE')
    this.failures = 0
    this.nextAttemptAt = 0
    this.lastHealth = { state: 'ok', checkedAt: Date.now() }
    // A watch that was armed before this reconnect is re-armed on the NEW client. Not awaited:
    // this runs inside `ensureClient`, so awaiting a command here would deadlock on the gate the
    // caller already holds.
    if (this.hint && this.idle) {
      void Promise.resolve().then(() => this.armIdle()).catch((error: unknown) => {
        this.options.log.warn('imap watch could not be re-armed after a reconnect', {
          accountId: this.options.accountId, error: String(error).slice(0, 200),
        })
      })
    }
    return client
  }

  /** Map, record, and decide whether the socket is worth keeping. */
  private async fail(error: unknown, what: string): Promise<ImapError> {
    const mapped = toProviderError(error, what)
    const detail = mapped.message.slice(0, 300)
    if (mapped.code === 'too-large' || mapped.code === 'not-found') return mapped
    if (mapped.code === 'auth') {
      // Nothing is retried: the credential is wrong until a human changes it, and the socket is
      // dropped so a later attempt starts from a clean LOGIN with whatever is stored then.
      this.lastHealth = { state: 'auth-required', checkedAt: Date.now(), detail }
      await this.drop()
      return mapped
    }
    this.failures += 1
    this.nextAttemptAt = Date.now() + Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** (this.failures - 1))
    this.lastHealth = { state: 'unreachable', checkedAt: Date.now(), detail }
    await this.drop()
    return mapped
  }

  private async drop(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try { client.close?.() }
    catch { /* already gone */ }
  }
}

/**
 * One connection per account, created on demand and closed on dispose.
 *
 * "One" is load bearing, and it is why the IN-FLIGHT creation is memoized and not just the
 * finished connection. Creating one reads the account's settings, which is a config read, which
 * is an await: two callers arriving during that await both missed the cache, so both built their
 * own ImapConnection, and the whole point of the connection (one gate, one command at a time)
 * was gone. The base does exactly that on a first sync, where arming the IDLE watch and polling
 * the inbox start in the same tick.
 */
export class ImapPool {
  private readonly connections = new Map<string, ImapConnection>()
  private readonly creating = new Map<string, Promise<ImapConnection>>()

  constructor(private readonly deps: {
    settings: (accountId: string) => Promise<ImapAccountSettings | undefined>
    password: (accountId: string) => Promise<string | undefined>
    log: ConnectionLog
    commandTimeoutMs?: number
  }) {}

  for(accountId: string): Promise<ImapConnection> {
    const existing = this.connections.get(accountId)
    if (existing) return Promise.resolve(existing)
    const pending = this.creating.get(accountId)
    if (pending) return pending
    const created = this.create(accountId)
    this.creating.set(accountId, created)
    // Cleared either way: a failure must not be cached, because the account may be configured a
    // second later, and a success is in `connections` by then.
    void created
      .finally(() => { if (this.creating.get(accountId) === created) this.creating.delete(accountId) })
      .catch(() => undefined)
    return created
  }

  health(accountId: string): ProviderHealth | undefined {
    return this.connections.get(accountId)?.health
  }

  async forget(accountId: string): Promise<void> {
    // Awaited first, so a connection created a millisecond ago is the one that gets closed
    // instead of being left behind by the delete.
    await this.creating.get(accountId)?.catch(() => undefined)
    const connection = this.connections.get(accountId)
    if (!connection) return
    this.connections.delete(accountId)
    await connection.dispose().catch(() => undefined)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.creating.values()].map((one) => one.catch(() => undefined)))
    const all = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(all.map((connection) => connection.dispose().catch(() => undefined)))
  }

  private async create(accountId: string): Promise<ImapConnection> {
    const settings = await this.deps.settings(accountId)
    if (!settings) {
      throw providerError('not-found', `No IMAP account "${accountId}" is configured on this box.`)
    }
    const connection = new ImapConnection({
      accountId,
      settings,
      password: () => this.deps.password(accountId),
      log: this.deps.log,
      ...(this.deps.commandTimeoutMs !== undefined ? { commandTimeoutMs: this.deps.commandTimeoutMs } : {}),
    })
    this.connections.set(accountId, connection)
    return connection
  }
}
