import type { PluginDatabaseClient } from '../../core/plugins/plugin-storage.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'

/**
 * The mail cache: the plugin's OWN `plugin.sqlite`, reached through
 * `walnut.storage.database`, which runs it on a worker thread.
 *
 * Three consequences of living there, all of them wanted:
 *
 * - The API is async by construction, so MIME parsing and body decoding leave the server's
 *   single event loop without anyone having to remember to make them.
 * - Migrations are versioned by the host (`_walnut_plugin_migrations`), so this file only
 *   declares SQL.
 * - Uninstalling the plugin deletes the file, which is what "the cache is disposable" means.
 *
 * What it costs, and what this file does about it:
 *
 * - Opening it spawns a worker thread. So it opens on FIRST USE, never at activate: a
 *   `walnut` CLI process, a loader unit test and a server that nobody has asked about mail
 *   all load this plugin, and none of them should pay a thread and a SQLite file for a
 *   mailbox that does not exist yet.
 * - A worker can wedge. Every call carries one shared deadline covering the open AND the
 *   statement, so a route answers `db_unavailable` instead of pinning a connection: one
 *   pinned response starves the browser's six-connection pool.
 *
 * The schema, the migrations and that deadline machinery live here; the statements and the row
 * shapes live in `store.ts`. Those two files are the only ones in this directory that write SQL.
 */

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id   TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'active',
  health_json  TEXT,
  payload      TEXT
);

CREATE TABLE IF NOT EXISTS mailboxes (
  account_id   TEXT NOT NULL,
  mailbox_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'other',
  unread       INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  cursor       TEXT,
  last_sync_at INTEGER,
  payload      TEXT,
  PRIMARY KEY (account_id, mailbox_id)
);

CREATE TABLE IF NOT EXISTS messages (
  account_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  rfc_message_id   TEXT NOT NULL DEFAULT '',
  mailbox_id       TEXT NOT NULL,
  thread_id        TEXT,
  from_addr        TEXT NOT NULL DEFAULT '',
  subject          TEXT NOT NULL DEFAULT '',
  snippet          TEXT NOT NULL DEFAULT '',
  sent_at          INTEGER NOT NULL DEFAULT 0,
  received_at      INTEGER,
  flags_json       TEXT,
  attachments_json TEXT,
  body_ref         TEXT,
  body_bytes       INTEGER,
  payload          TEXT,
  PRIMARY KEY (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS messages_by_mailbox ON messages (account_id, mailbox_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS messages_by_rfc_id ON messages (rfc_message_id);

-- Contentless (content=''): tokens only, no second copy of the body. Reads return no column
-- values by design, so every query against it selects rowid and joins back to messages.
-- contentless_delete=1 is NOT optional here: a plain contentless table refuses DELETE
-- ("cannot DELETE from contentless fts5 table"), and retention has to prune this index with
-- the messages it indexes. Adding it later would mean a DROP, a CREATE and a full re-tokenize.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(subject, from_addr, snippet, body_text, content='', contentless_delete=1);

CREATE TABLE IF NOT EXISTS drafts (
  draft_id           TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  in_reply_to        TEXT,
  to_json            TEXT NOT NULL DEFAULT '[]',
  subject            TEXT NOT NULL DEFAULT '',
  body_md            TEXT NOT NULL DEFAULT '',
  revision           INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL DEFAULT 'composing',
  origin             TEXT,
  created_by_session TEXT,
  payload            TEXT
);

CREATE TABLE IF NOT EXISTS sends (
  send_id             TEXT PRIMARY KEY,
  draft_id            TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL UNIQUE,
  approval_kind       TEXT,
  approval_ref        TEXT,
  state               TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error               TEXT
);
`

/**
 * v2 exists so a re-poll of an unchanged page is provably a no-op.
 *
 * `envelope_hash` is what the upsert compares: equal hash means the row is not touched at
 * all, so `updated_at` stays where it was and the sync's "updated" count stays honest. Doing
 * it the obvious way (always UPDATE, then look at `changes`) reports every re-poll as an
 * update, which then rides the bus as a change event and refreshes a console for nothing.
 */
const SCHEMA_V2 = `
ALTER TABLE messages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN envelope_hash TEXT;
`

/**
 * A body this message will never have, and why.
 *
 * Without it the prefetch re-downloads the same unfetchable bodies on every single tick:
 * `bodylessMessages` selects on `body_ref IS NULL`, and a message that is over the cap or gone
 * from the server never gets a `body_ref`. On a photo-heavy inbox that is tens of megabytes an
 * hour against the user's own mail server, forever.
 */
const SCHEMA_V3 = `
ALTER TABLE messages ADD COLUMN body_error TEXT;
`

/**
 * v4 is the send path: the columns the draft state machine and the approval ledger need.
 *
 * The v1 shape had the two tables but only the fields a draft LIST wants. What the ledger
 * needs on top of that is timestamps at every transition, because the honest answer to "did
 * this send?" is reconstructed from them: `attempted_at` is what the reaper reads to decide a
 * row has been `sending` too long to still be running, and `settled_at` is what proves an
 * outcome was actually recorded rather than inferred. `revision` rides its own column even
 * though `idempotency_key` already spells it, so the reaper and the ledger can filter on it
 * without parsing a key.
 *
 * The index is on `(draft_id, state)` because every question the ledger asks is "what has this
 * draft got in flight", and without it that is a table scan on the one path where a scan means
 * a second `provider.send`.
 */
const SCHEMA_V4 = `
ALTER TABLE drafts ADD COLUMN letter_id TEXT;
ALTER TABLE drafts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN approved_at INTEGER;
ALTER TABLE drafts ADD COLUMN discarded_at INTEGER;
ALTER TABLE drafts ADD COLUMN error TEXT;

ALTER TABLE sends ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN attempted_at INTEGER;
ALTER TABLE sends ADD COLUMN settled_at INTEGER;

CREATE INDEX IF NOT EXISTS sends_by_draft_state ON sends (draft_id, state);
CREATE INDEX IF NOT EXISTS drafts_by_account_state ON drafts (account_id, state, updated_at DESC);
`

/**
 * v5 makes "what else is in this thread" one query instead of a scan.
 *
 * `thread_id` has been written since v1 but nothing ever selected on it, so the only way to
 * collect a thread was to walk the account's newest rows and filter. That is bounded work by
 * construction (a 50k-row account cannot be read to answer one question), which means a reply
 * three months back was simply reported missing. The index is `(account_id, thread_id, sent_at)`
 * so the collect and the sort are the same index scan, and the answer is complete regardless of
 * how far back the thread reaches.
 */
const SCHEMA_V5 = `
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (account_id, thread_id, sent_at);
`

/**
 * v6 is this slice's two small tables: which message became which task, and one key/value row.
 *
 * The ledger lives HERE rather than in the framework's `task_remote_links`, and that is a
 * deliberate call. That table is the sync sources' ledger: a row there says an outside system owns
 * this task and a two-way sync may write back to it. A mail message is not a task's other half, it
 * is where a task came from once, so a link there would enrol every mail-made task in a sync
 * contract nothing implements. Keeping it in the plugin's own file also keeps the kernel mail-free,
 * and it means uninstalling the plugin drops the ledger with the cache while the tasks stay.
 *
 * The key is the RFC Message-ID when there is one, so the same mail found again in another mailbox
 * (or re-synced after eviction, with a different provider handle) still maps to the one task. The
 * `cache:[...]` fallback exists because `rfc_message_id` defaults to '': without it, every
 * Message-ID-less message in the install would collide on one primary key and share one task.
 */
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS message_tasks (
  rfc_message_id TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS message_tasks_by_account ON message_tasks (account_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- "Every open draft, whatever the account", which is what GET /drafts now defaults to. The v4
-- index leads with account_id, so a query that names only the state could not use it and scanned.
CREATE INDEX IF NOT EXISTS drafts_by_state_updated ON drafts (state, updated_at DESC);
`

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
  { version: 6, sql: SCHEMA_V6 },
]

/**
 * Every column of `messages` a row read selects, named next to the schema that declares them.
 *
 * Here rather than in store.ts because two query files now need it (`store.ts` for the mailbox
 * reads, `store-tasks.ts` for the digest's unread listing), and a list of columns that has to agree
 * with a CREATE TABLE belongs beside that CREATE TABLE. `SELECT *` is not the alternative: the row
 * shape is a typed interface, and a column added by a later migration would then silently arrive in
 * objects nothing declared.
 */
export const MESSAGE_COLUMNS =
  'rowid, account_id, message_id, rfc_message_id, mailbox_id, thread_id, from_addr, subject,'
  + ' snippet, sent_at, received_at, flags_json, attachments_json, body_ref, body_bytes,'
  + ' payload, updated_at, envelope_hash, body_error'

/** One budget per call, shared by the open and the statement. */
const CALL_DEADLINE_MS = 5_000

/**
 * How long a failed open is remembered before the next call tries again.
 *
 * A failure must not be permanent for the life of the process (a full disk that gets cleared, a
 * worker that lost a race at boot), but a hot route must not spawn a worker thread per request
 * either, so the retry is rate limited rather than immediate.
 */
const OPEN_RETRY_COOLDOWN_MS = 5_000

export type MailDbStatus = 'migrating' | 'ready' | 'failed'

export class MailDatabaseUnavailableError extends Error {
  readonly code = 'db_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'MailDatabaseUnavailableError'
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MailDatabaseUnavailableError(`the mail database did not ${what} within ${ms}ms`)),
      Math.max(1, ms),
    )
    timer.unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export class MailDatabase {
  private client: PluginDatabaseClient | null = null
  private opening: Promise<void> | null = null
  private state: MailDbStatus = 'migrating'
  private closed = false
  private lastFailureAt = 0

  constructor(
    private readonly walnut: WalnutServerPluginApi,
    private readonly now: () => number = Date.now,
  ) {}

  get status(): MailDbStatus {
    return this.state
  }

  run(sql: string, params?: unknown): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    return this.call((client) => client.run(sql, params))
  }

  get<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T | undefined> {
    return this.call((client) => client.get<T>(sql, params))
  }

  all<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
    return this.call((client) => client.all<T>(sql, params))
  }

  /**
   * `undefined` when the cache is not readable, so the health answer never needs a try.
   *
   * It DOES wait for the open (under the same deadline as any other call): health is the
   * route someone asks when they suspect the cache is broken, so it must report the settled
   * answer rather than the sampling accident of "migrating" on every first request.
   */
  async countOrNull(sql: string): Promise<number | undefined> {
    try {
      return (await this.get<{ n: number }>(sql))?.n ?? 0
    } catch {
      return undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (activeDatabase === this) activeDatabase = null
    const client = this.client
    this.client = null
    this.opening = null
    if (client) await client.dispose().catch(() => undefined)
  }

  private ensureOpen(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new MailDatabaseUnavailableError('the mail database is closed'))
    }
    if (this.opening) return this.opening
    if (this.state === 'failed' && this.now() - this.lastFailureAt < OPEN_RETRY_COOLDOWN_MS) {
      return Promise.reject(new MailDatabaseUnavailableError(
        'the mail cache failed to open and is waiting out its retry cooldown',
      ))
    }
    this.state = 'migrating'
    const attempt = (async () => {
      const client = this.walnut.storage.database
      this.client = client
      await client.migrate(MIGRATIONS)
      this.state = 'ready'
    })().catch((error) => {
      // A failure is remembered, not final: the next call after the cooldown opens a fresh
      // attempt. Clearing `opening` is the whole point, since a rejected promise cached here
      // would make one bad boot permanent for the life of the process.
      this.state = 'failed'
      this.lastFailureAt = this.now()
      this.client = null
      if (this.opening === attempt) this.opening = null
      throw new MailDatabaseUnavailableError(`the mail cache could not be opened: ${reason(error)}`)
    })
    this.opening = attempt
    // Nothing awaits this until the first call, and an unhandled rejection would take the
    // whole process down. `state` is what carries the failure to /health.
    attempt.catch(() => undefined)
    return attempt
  }

  private async call<T>(work: (client: PluginDatabaseClient) => Promise<T>): Promise<T> {
    const started = Date.now()
    await withDeadline(this.ensureOpen(), CALL_DEADLINE_MS, 'open')
    const client = this.client
    if (!client) throw new MailDatabaseUnavailableError('the mail database is closed')
    const remaining = CALL_DEADLINE_MS - (Date.now() - started)
    return withDeadline(work(client), remaining, 'answer')
  }
}

/**
 * One mail plugin instance per process, so the open database is reachable by module scope.
 * A reload replaces it; a dispose clears it.
 */
let activeDatabase: MailDatabase | null = null

export function openMailDatabase(walnut: WalnutServerPluginApi): MailDatabase {
  activeDatabase = new MailDatabase(walnut)
  return activeDatabase
}

/** Test-only: lets a test prove FTS5 works through the real worker-thread database. */
export function mailDatabaseForTesting(): MailDatabase | null {
  return activeDatabase
}

