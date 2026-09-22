/**
 * The mail plugin's HTTP surface, typed for the console.
 *
 * Everything here talks to `/api/plugins/mail/*` and nothing else: mail has no `/api/mail`
 * alias, because it had no client to keep working when the plugin took the domain over.
 *
 * The DTOs below MIRROR `src/integrations/mail/{types,service}.ts` rather than importing them.
 * They are the same shapes on purpose, and the duplication is deliberate: `web/tsconfig.json`
 * compiles `web/src` plus four named `@open-walnut/*` aliases, and none of them reaches
 * `src/integrations/`. Adding a fifth alias would mean editing the web tsconfig and the vite
 * config for four interfaces. If a field moves on the server, it moves here too, and the
 * browser test that reads a real body is what notices.
 *
 * Two shapes carry a warning with them:
 * - `MailBodyDto.html` is RAW, exactly as the message arrived. It is sanitized next to the
 *   renderer (see `apps/mail/mail-sanitize.ts`), never here and never on the server.
 * - Every string in a message is written by whoever sent it. Nothing in this file may be put
 *   into `dangerouslySetInnerHTML` or an href without going through that path first.
 */
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from './client';

const BASE = '/api/plugins/mail';

/**
 * A 503 from this plugin is a STATE the console renders in words (a cloud replica standing
 * aside, the cache still opening), not a fault worth an error line in the console.
 */
const QUIET = { quietStatuses: [503] };

export interface MailCapabilities {
  search: boolean;
  watch: boolean;
  drafts: boolean;
  markRead: boolean;
  flags: boolean;
  threads: boolean;
  send: boolean;
  sendAsReply: boolean;
  bodies: 'text' | 'html' | 'both';
  attachments: 'none' | 'metadata' | 'download';
}

export type AccountSetupFieldKind = 'text' | 'password' | 'select';

export interface AccountSetupField {
  name: string;
  label: string;
  kind: AccountSetupFieldKind;
  help?: string;
  required?: boolean;
  placeholder?: string;
  /** Only for `select`. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * A known service behind a provider: the server values a person would otherwise look up.
 *
 * `match` is address domains, lowercase and without an `@`, so typing the address is enough to
 * pick one. `values` are `AccountSetupField` names, and a preset names a subset: the servers,
 * never the credential.
 */
export interface AccountSetupPreset {
  id: string;
  label: string;
  match?: string[];
  values: Record<string, string>;
  help?: string;
  /** The provider's own public page for the credential. Opened in a new tab. */
  helpUrl?: string;
  /** What to do to get that credential, in order. A step's `url` is rendered as a link. */
  steps?: AccountSetupStep[];
}

/** One action in a preset's recipe, declared by the provider. */
export interface AccountSetupStep {
  text: string;
  url?: string;
}

export interface MailProviderSummary {
  id: string;
  label: string;
  capabilities: MailCapabilities;
  /** The add-an-account form, as data. The console knows no provider's fields. */
  setupFields: AccountSetupField[];
  /** Known services, when the provider declared any. Absent means it has none. */
  setupPresets?: AccountSetupPreset[];
}

export type MailAccountState = 'active' | 'auth-required' | 'disabled';

export interface MailAccountHealth {
  state: 'ok' | 'auth-required' | 'unreachable' | 'degraded';
  /** Epoch milliseconds. */
  checkedAt: number;
  detail?: string;
}

/** What `POST /accounts` answers with: the provider's own record, before any cache arithmetic. */
export interface MailAccountBase {
  accountId: string;
  providerId: string;
  displayName: string;
  address: string;
  state: MailAccountState;
  health?: MailAccountHealth;
}

export interface MailAccountDto extends MailAccountBase {
  /** Summed from the account's mailboxes, which report it from the provider. */
  unread: number;
  /**
   * Unread in the INBOX-role mailboxes only, which is what a badge means.
   *
   * Optional here because a console tab open across the deploy that added it still gets an
   * account row without it. The pane's badge arithmetic reads the mailbox rows either way.
   */
  unreadInbox?: number;
  /**
   * What THIS account can do, when the provider answers per account.
   *
   * Preferred over the provider-level `capabilities.send` everywhere the console decides whether to
   * offer a Send: two IMAP accounts behind one provider genuinely differ, because reading needs a
   * password and sending needs SMTP settings the human may never have filled in. Absent means the
   * provider has no per-account answer, or the tab predates the field.
   */
  capabilities?: { send: boolean };
}

export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | 'other';

export interface MailboxDto {
  accountId: string;
  mailboxId: string;
  name: string;
  role: MailboxRole;
  unread: number;
  total: number;
  lastSyncAt?: number;
}

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailAttachmentMeta {
  id?: string;
  filename?: string;
  mimeType?: string;
  bytes?: number;
}

export interface MailMessageDto {
  messageId: string;
  accountId: string;
  mailboxId: string;
  rfcMessageId: string;
  from: MailAddress;
  to: MailAddress[];
  /** The rest of the recipients, and where the sender asked answers to go. */
  cc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  snippet: string;
  /** Epoch milliseconds. Mail dates are instants, never wall time. */
  sentAt: number;
  /** The original `Date` header, verbatim, for the reader's tooltip. */
  sentAtHeader?: string;
  receivedAt?: number;
  flags: string[];
  attachments: MailAttachmentMeta[];
  hasBody: boolean;
  threadId?: string;
  /**
   * The task this message was turned into, when it was.
   *
   * Derived by the server on every read from its own ledger, so it is never stale: a task the human
   * deletes stops appearing here. The reader shows the task pill instead of the button when it is
   * set, and `plugin:mail:message-tasked` is what fills it in without a refetch.
   */
  taskId?: string;
  /**
   * How this message can be unsubscribed from, and whether it already was.
   *
   * ABSENT means the server captured nothing, which reads exactly as `available: 'none'`: no
   * `List-Unsubscribe` header, or a message cached before Walnut asked for one and never opened
   * since. Read it as `message.unsubscribe?.available ?? 'none'` and never as "the field is missing,
   * something is wrong".
   *
   * `available` costs the server nothing (it is derived from what the poll already stored);
   * `done`/`attempt` are derived per read from its own ledger, so a stale `done` is impossible.
   */
  unsubscribe?: MailUnsubscribeDto;
}

export type MailUnsubscribeAvailability = 'one-click' | 'mailto' | 'link' | 'none';

export interface MailUnsubscribeDto {
  available: MailUnsubscribeAvailability;
  /** Set when this message, or another of the same list, was already unsubscribed from. */
  done?: {
    method: string;
    at: number;
    scope: 'message' | 'list';
    /**
     * What the list key was taken from, with `scope: 'list'`: a `List-Id` the sender published, or
     * its address as the coarser fallback.
     *
     * It decides one word, and the word matters. One sender running three lists off one address
     * shares a key, so leaving one marks all three; saying "this list" there would tell somebody they
     * had left a list they are still on. Absent means the server did not say, which reads as `sender`.
     */
    keyedBy?: 'list-id' | 'sender';
  };
  /**
   * This message's own attempt, while it is anything other than `done`.
   *
   * Three states, not a boolean, because the console says something different about each:
   * `in-flight` is `Unsubscribing…`, `needs-human` is a page somebody has to finish, and `failed` is
   * a click worth making again. `reason` is the server's own key (`confirm-form`, `cannot-send`,
   * `send-unknown`, …) — switch on it, never print it; the route's `message` is the sentence.
   */
  attempt?: {
    status: 'in-flight' | 'needs-human' | 'failed';
    reason?: string;
    at: number;
  };
}

export interface MailBodyDto {
  format: 'text' | 'html' | 'both';
  text?: string;
  /** RAW. Sanitize before rendering; see the file header. */
  html?: string;
  bytes: number;
  truncated: boolean;
}

export interface MailMessagePage {
  messages: MailMessageDto[];
  /**
   * Feed back as `before` for the next page. Absent means the list ended.
   *
   * An OPAQUE token, never a number to reason about: it carries the whole sort key (a timestamp, a
   * message id, and on a cross-account page the account too), so the server can grow the key without
   * a client change and a caller cannot invent a position the server never issued.
   */
  nextBefore?: string;
}

export interface MailMessageRead {
  message: MailMessageDto;
  body: MailBodyDto | null;
  /** A body that could not be fetched. The envelope is still real data. */
  bodyError?: string;
}

export interface MailSearchResult {
  messages: MailMessageDto[];
  source: 'provider' | 'cache';
}

export interface MailRefreshResult {
  ok: boolean;
  /** False on a 202: the sync is still running and the live events finish the job. */
  completed: boolean;
  added?: number;
  updated?: number;
  polled?: number;
  skipped?: number;
  incomplete?: boolean;
}

/** What one on-demand folder fetch did. Mirrors `MailboxFetchReport` in the plugin. */
export interface MailboxFetchResult {
  ok: boolean;
  fetched: boolean;
  added?: number;
  updated?: number;
  /** Only set when nothing was fetched. `running` is the 202: it is still going. */
  reason?: 'replica' | 'stopped' | 'unknown-mailbox' | 'failed';
  running?: boolean;
  detail?: string;
}

export interface MailHealth {
  ok: boolean;
  providers: number;
  accounts: number;
  db: string;
  polling: boolean;
  lastTickAt: number;
  replica: boolean;
}

/**
 * One path segment per id, each encoded on its own.
 *
 * A message handle is `<mailbox>:<uidvalidity>:<uid>` and a mailbox name may contain a slash
 * ("Projects/2026") or a colon, so the separators have to survive the trip: the plugin's route
 * decodes each segment back. Joining ids without encoding is how a folder with a slash in its
 * name becomes a 404.
 */
function messagePath(accountId: string, messageId: string): string {
  return `${BASE}/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}`;
}

/** The plugin's `{ error, message }` pair, whatever shape the failure arrived in. */
export interface MailFailure {
  status: number;
  /** The machine code: `auth`, `unsupported`, `primary_only`, `db_unavailable`, … */
  code: string;
  /** The provider's own words, which is what the human is shown. */
  message: string;
}

export function mailFailure(error: unknown): MailFailure {
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { error?: string; message?: string };
    return {
      status: error.status,
      code: body.error ?? error.message ?? 'unknown',
      message: body.message ?? error.message ?? 'the mail plugin did not say what went wrong',
    };
  }
  return { status: 0, code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

export function listMailProviders(): Promise<{ providers: MailProviderSummary[] }> {
  return apiGet(`${BASE}/providers`, undefined, QUIET);
}

export function listMailAccounts(): Promise<{ accounts: MailAccountDto[] }> {
  return apiGet(`${BASE}/accounts`, undefined, QUIET);
}

/**
 * Hand a provider its own setup values.
 *
 * They go straight to the provider and are never persisted, logged or echoed by the base, so
 * this call is the only place a credential exists in the browser. Nothing keeps a copy.
 */
export function createMailAccount(
  providerId: string,
  values: Record<string, string>,
): Promise<{ account: MailAccountBase }> {
  // A refused credential is the most ordinary outcome of this call, so 401 is not an incident.
  return apiPost(`${BASE}/accounts`, { providerId, values }, { quietStatuses: [401] });
}

export function deleteMailAccount(accountId: string): Promise<{ ok: boolean; messages: number }> {
  return apiDelete(`${BASE}/accounts/${encodeURIComponent(accountId)}`);
}

export function listMailboxes(accountId: string): Promise<{ mailboxes: MailboxDto[] }> {
  return apiGet(`${BASE}/mailboxes`, { account: accountId }, QUIET);
}

/**
 * One page of a mailbox.
 *
 * `unread` is the SERVER's filter, over the whole mailbox rather than over the page: a mailbox with
 * more unread mail than a page holds cannot be filtered in the browser without calling a fraction of
 * the unread mail all of it. It pages with `before` exactly like the unfiltered list.
 *
 * `scope` is the cross-account list: ONE query the server answers from every account holding that
 * role, never several per-account pages merged here (a merge in the browser cannot page). It is
 * mutually exclusive with `accountId`, which the server refuses with a 400 rather than guessing.
 */
export function listMailMessages(query: {
  accountId?: string;
  mailboxId?: string;
  limit?: number;
  before?: string;
  unread?: boolean;
  scope?: 'role:inbox' | 'role:sent' | 'role:drafts';
}): Promise<MailMessagePage> {
  const params: Record<string, string> = {};
  if (query.accountId) params.account = query.accountId;
  if (query.mailboxId) params.mailbox = query.mailboxId;
  if (query.limit) params.limit = String(query.limit);
  if (query.before !== undefined) params.before = query.before;
  if (query.unread) params.unread = '1';
  if (query.scope) params.scope = query.scope;
  return apiGet(`${BASE}/messages`, params, QUIET);
}

/**
 * One message, with its body when there is one.
 *
 * `retry` matters: the plugin remembers a body it could not fetch (`body_error`) and short-circuits
 * every later read with the same notice, so a "Try again" that omits this asks for the cached
 * failure and renders the same words forever. Only a human pressing retry sets it.
 */
export function readMailMessage(
  accountId: string,
  messageId: string,
  opts?: { retry?: boolean },
): Promise<MailMessageRead> {
  return apiGet(messagePath(accountId, messageId), opts?.retry ? { retry: '1' } : undefined, QUIET);
}

/** 409 `unsupported` when the provider cannot change the flag; the caller reverts. */
export function markMailMessageRead(
  accountId: string,
  messageId: string,
  read: boolean,
): Promise<{ ok: boolean; message: MailMessageDto }> {
  // 409 is a capability answer the console handles by rolling back, not a failure.
  return apiPost(`${messagePath(accountId, messageId)}/read`, { read }, { quietStatuses: [409] });
}

/** What `POST /messages/:a/:m/task` answers with. `created: false` means it already had one. */
export interface MailMessageTask {
  taskId?: string;
  created?: boolean;
  /** True on a 202: the write is still running, and asking again returns the task. */
  pending?: boolean;
  message?: string;
}

/**
 * Make a task out of one message, or learn which task it already is.
 *
 * Idempotent on the SERVER, which is what makes a double click harmless: the second call answers
 * 200 with the same `taskId` and `created: false`. The console still guards the button, but it does
 * not have to be right for the data to stay right.
 */
export function createMailMessageTask(
  accountId: string,
  messageId: string,
  input?: { title?: string; project?: string; note?: boolean },
): Promise<MailMessageTask> {
  return apiPost(`${messagePath(accountId, messageId)}/task`, input ?? {}, QUIET);
}

/**
 * What the unsubscribe route answers with, in one shape for every outcome.
 *
 * `message` is always present and is always the sentence to show: the server knows whether a page
 * asked for a confirmation, whether its guard refused the link, or whether the sender's endpoint said
 * no, and inventing local wording for those would drift from what actually happened.
 *
 * A `failed` outcome arrives as an HTTP 200 with `ok: false`, deliberately: it is not a fault of the
 * request, so it resolves rather than throwing, and the console prints `message`. The two real
 * refusals throw an `ApiError`: 409 `already` / `in-flight` (with the ledger row on the error body)
 * and 409 `unsupported` (nothing to open at all).
 */
export interface MailUnsubscribeResult {
  ok: boolean;
  status: 'done' | 'needs-human' | 'failed' | 'in-flight';
  method: 'one-click' | 'mailto' | 'link' | 'manual';
  at?: number;
  /** `confirm-form`, `unclear`, `http-403`, `timeout`, `blocked-host`, `cannot-send`, `send-unknown`, … */
  reason?: string;
  detail?: string;
  /** The page a human still has to finish, on anything other than `done`. */
  url?: string;
  /** False on the 202: the ladder outlived the response and settles on its own. */
  completed?: boolean;
  message: string;
}

/**
 * Leave the mailing list this message came from.
 *
 * `method` is optional and omitting it is the normal call: the server picks the best rung the message
 * offers. Naming one the message does not have is a 400 rather than a silent fallback, because "I
 * asked for the one-click and got a mail draft" is not a thing a console should have to guess about.
 *
 * Every 409 is quiet: `already` (the human is off this list), `in-flight` (their own second click) and
 * `unsupported` (nothing to open) are all STATES the console renders in words, not faults.
 */
export function unsubscribeMailMessage(
  accountId: string,
  messageId: string,
  input?: { method?: 'one-click' | 'mailto' | 'link'; confirm?: boolean },
): Promise<MailUnsubscribeResult> {
  return apiPost(
    `${messagePath(accountId, messageId)}/unsubscribe`,
    input ?? {},
    { quietStatuses: [409, 503] },
  );
}

export interface MailDigestResult {
  /** Null when nothing was unread, so no letter was sent. */
  letterId?: string | null;
  unread?: number;
  accounts?: number;
  pending?: boolean;
  /**
   * The server could not read enough of the cache to answer, so every number here is a floor.
   *
   * It exists because "nothing is unread" and "nothing was looked at" are the same zero. Telling
   * somebody with a full mailbox that nothing is unread is a lie they cannot act on.
   */
  incomplete?: boolean;
  /** The server's own sentence about the outcome, when it has one. Preferred over anything local. */
  message?: string;
}

/** Send the digest letter now. It does not consume today's scheduled one. */
export function sendMailDigestNow(): Promise<MailDigestResult> {
  return apiPost(`${BASE}/digest/send-now`, {}, { ...QUIET, timeoutMs: 20_000 });
}

export function searchMail(query: {
  accountId?: string;
  q: string;
  limit?: number;
}): Promise<MailSearchResult> {
  const params: Record<string, string> = { q: query.q };
  if (query.accountId) params.account = query.accountId;
  if (query.limit) params.limit = String(query.limit);
  return apiGet(`${BASE}/search`, params, QUIET);
}

/**
 * Ask for a sync now.
 *
 * `completed: false` is a 202 and the normal answer for a big mailbox: the refresh is running
 * and `plugin:mail:sync-completed` says when it landed. A request that waited for the whole
 * sync would hold one of the browser's six connections for the duration.
 */
export function refreshMail(accountId?: string): Promise<MailRefreshResult> {
  return apiPost(`${BASE}/refresh`, accountId ? { accountId } : {}, {
    timeoutMs: 20_000,
    // 503 is the replica and the cache-still-opening answer, both of which the console explains.
    quietStatuses: [503],
  });
}

/**
 * Fetch ONE folder now, for a folder the background sweep has not reached yet.
 *
 * `fetched: false` with a `reason` is a real answer, not a failure: the loop declines on a replica
 * and for a folder the provider has stopped listing. A 202 (`running`) means the fetch outlived its
 * budget and `plugin:mail:sync-completed` will say when the rows land.
 */
export function fetchMailbox(accountId: string, mailboxId: string): Promise<MailboxFetchResult> {
  return apiPost(`${BASE}/mailboxes/fetch`, { accountId, mailboxId }, {
    timeoutMs: 20_000,
    quietStatuses: [503],
  });
}

export function mailHealth(): Promise<MailHealth> {
  return apiGet(`${BASE}/health`, undefined, QUIET);
}

/** The provider half of an account id. Ids split on the FIRST separator only. */
export function providerIdOf(accountId: string): string {
  const at = accountId.indexOf(':');
  return at > 0 ? accountId.slice(0, at) : accountId;
}

// ── the write path: drafts, the approval ledger, sending ──
//
// `revision` is the field that matters in every call below. A send-ish request carries the
// revision the human was looking at, and a mismatch answers 409 `stale` rather than sending text
// nobody read. Two designed non-2xx answers ride these routes, so both are quiet: 409 (stale,
// unsupported, invalid) and 503 (a replica standing aside, the cache still opening).

export type MailDraftState =
  | 'composing'
  | 'pending_approval'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'discarded';

export type MailSendState = 'approved' | 'sending' | 'sent' | 'failed' | 'unknown';

export interface MailDraftDto {
  draftId: string;
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyMarkdown: string;
  /** The RFC `Message-ID` this draft answers, when it is a reply. Set by the SERVER. */
  inReplyTo?: string;
  references?: string[];
  revision: number;
  state: MailDraftState;
  origin: 'console' | 'agent';
  createdBySession?: string;
  /** The outstanding approval letter, while there is one. */
  letterId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface MailSendDto {
  sendId: string;
  draftId: string;
  accountId: string;
  revision: number;
  /** `<draftId>:<revision>`, UNIQUE: one approved revision can produce ONE send. */
  idempotencyKey: string;
  approvalKind: 'letter' | 'console';
  /** The letter id for a letter approval, the word `console` for a console one. */
  approvalRef: string;
  state: MailSendState;
  providerMessageId?: string;
  error?: string;
  attemptedAt?: number;
  settledAt?: number;
}

/**
 * What a write answers when it ran out of its 10s response budget.
 *
 * `completed: false` is a 202 and never a failure: the letter, the ledger row and the SMTP
 * attempt all outlive the request that started them, and the console hears the outcome on
 * `plugin:mail:draft-changed` / `plugin:mail:send-settled`.
 */
interface MailSlowWrite {
  ok?: boolean;
  completed?: boolean;
  message?: string;
}

export interface MailDraftApproval extends MailSlowWrite {
  draft?: MailDraftDto;
  /** The letter the human was asked with. Absent on a 202: it is still being prepared. */
  letterId?: string;
}

export interface MailDraftSend extends MailSlowWrite {
  send?: MailSendDto;
  draft?: MailDraftDto;
}

/** The fields a draft edit may carry. Anything omitted keeps its stored value. */
export interface MailDraftPatch {
  to?: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject?: string;
  bodyMarkdown?: string;
}

const WRITE_QUIET = { quietStatuses: [409, 503] };

function draftPath(draftId: string): string {
  return `${BASE}/drafts/${encodeURIComponent(draftId)}`;
}

export function listMailDrafts(query?: {
  accountId?: string;
  state?: MailDraftState;
  limit?: number;
}): Promise<{ drafts: MailDraftDto[] }> {
  const params: Record<string, string> = {};
  if (query?.accountId) params.account = query.accountId;
  if (query?.state) params.state = query.state;
  if (query?.limit) params.limit = String(query.limit);
  return apiGet(`${BASE}/drafts`, Object.keys(params).length ? params : undefined, QUIET);
}

export function getMailDraft(draftId: string): Promise<{ draft: MailDraftDto; sends: MailSendDto[] }> {
  return apiGet(draftPath(draftId), undefined, WRITE_QUIET);
}

/**
 * Create a draft.
 *
 * `inReplyTo` names the message being answered by its CACHE handle, and the server copies the
 * threading headers and the `Re:` subject from the row it already holds. The client cannot aim a
 * reply into a thread it never read, which is why this is a pair of ids and not a header.
 */
export function createMailDraft(input: {
  accountId: string;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  bodyMarkdown: string;
  inReplyTo?: { accountId: string; messageId: string };
}): Promise<{ draft: MailDraftDto }> {
  return apiPost(`${BASE}/drafts`, { ...input, origin: 'console' }, WRITE_QUIET);
}

/**
 * Edit a draft: `revision + 1`, and back to `composing`.
 *
 * A draft that had a letter out is a special case the SERVER owns: it withdraws that letter and
 * issues a fresh one for the new revision, so the answer carries a `letterId` and the draft comes
 * back `pending_approval` again. A phone must never show a live Send over text that changed.
 */
export function patchMailDraft(draftId: string, patch: MailDraftPatch): Promise<MailDraftApproval> {
  // 409 is a DESIGNED answer here (an edit that raced a send), so it is quiet: the console handles
  // it in words, and an expected outcome in the error-log audit is how a real fault gets lost.
  return apiPatch(draftPath(draftId), patch, WRITE_QUIET);
}

export function deleteMailDraft(draftId: string): Promise<{ ok: boolean; draft?: MailDraftDto }> {
  return apiDelete(draftPath(draftId));
}

/** Ask the human on their phone. 409 `unsupported` when the account has no outgoing mail. */
export function requestMailDraftSend(draftId: string, revision: number): Promise<MailDraftApproval> {
  return apiPost(`${draftPath(draftId)}/request-send`, { revision }, WRITE_QUIET);
}

/** The console's own Send: the same ledger, with this click as the approval. */
export function sendMailDraft(draftId: string, revision: number): Promise<MailDraftSend> {
  return apiPost(`${draftPath(draftId)}/send`, { revision }, {
    ...WRITE_QUIET,
    // The route answers within 10s by design, but an SMTP handshake is what it is waiting on.
    timeoutMs: 20_000,
  });
}

export function listMailSends(query?: {
  accountId?: string;
  draftId?: string;
  limit?: number;
}): Promise<{ sends: MailSendDto[] }> {
  const params: Record<string, string> = {};
  if (query?.accountId) params.account = query.accountId;
  if (query?.draftId) params.draft = query.draftId;
  if (query?.limit) params.limit = String(query.limit);
  return apiGet(`${BASE}/sends`, Object.keys(params).length ? params : undefined, QUIET);
}

/**
 * Retry a FAILED send: a whole fresh approval round at a new revision, never a second attempt.
 *
 * 409 `invalid` for anything else, and that includes `unknown` on purpose: the message may
 * already be in the recipient's mailbox and only the Sent folder can say.
 */
export function retryMailSend(sendId: string): Promise<MailDraftApproval> {
  return apiPost(`${BASE}/sends/${encodeURIComponent(sendId)}/retry`, {}, WRITE_QUIET);
}
