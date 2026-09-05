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
import { ApiError, apiDelete, apiGet, apiPost } from './client';

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

export interface MailProviderSummary {
  id: string;
  label: string;
  capabilities: MailCapabilities;
  /** The add-an-account form, as data. The console knows no provider's fields. */
  setupFields: AccountSetupField[];
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
  /** Feed back as `before` for the next page. Absent means the list ended. */
  nextBefore?: number;
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

export function listMailMessages(query: {
  accountId?: string;
  mailboxId?: string;
  limit?: number;
  before?: number;
}): Promise<MailMessagePage> {
  const params: Record<string, string> = {};
  if (query.accountId) params.account = query.accountId;
  if (query.mailboxId) params.mailbox = query.mailboxId;
  if (query.limit) params.limit = String(query.limit);
  if (query.before !== undefined) params.before = String(query.before);
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

export function mailHealth(): Promise<MailHealth> {
  return apiGet(`${BASE}/health`, undefined, QUIET);
}

/** The provider half of an account id. Ids split on the FIRST separator only. */
export function providerIdOf(accountId: string): string {
  const at = accountId.indexOf(':');
  return at > 0 ? accountId.slice(0, at) : accountId;
}
