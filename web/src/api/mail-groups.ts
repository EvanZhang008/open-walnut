/**
 * The inbox sorting half of the mail plugin's HTTP surface: groups, bulk read, batch
 * unsubscribe and the rules file.
 *
 * Types MIRROR `src/integrations/mail/sort-types.ts` (the web tsconfig cannot reach the server
 * tree; see the note at the top of `./mail.ts`). A refusal (409 stale / in-flight / changed,
 * 410 expired, 400 invalid) arrives as an `ApiError` whose `body` is the server's JSON, so a
 * caller reads `error.body.error` and `error.body.message` rather than parsing text.
 */
import { apiGet, apiPost, apiPut } from './client';

const BASE = '/api/plugins/mail';
/** Refusals the UI renders in words, kept out of the console error audit. */
const QUIET = { quietStatuses: [409, 410, 503] };

export type MailGroupsScope = { role: 'inbox' } | { accountId: string; mailboxId: string };
export type MailGroupId = string;
export type MailSenderKind = 'person' | 'bulk' | 'transactional' | 'unknown';

export interface MailWatermark { at: number; seq: number }

export interface MailRulesError {
  line?: number;
  rule?: { index: number; id?: string };
  message: string;
  since: number;
}

/** One group row: unread mail only (a group with none is never in the answer). */
export interface MailGroupItem {
  id: MailGroupId;
  label: string;
  renamed?: boolean;
  unread: number;
  newestAt: number;
  topSenders: Array<{ key: string; label: string; unread: number }>;
  unsubscribable: number;
  markableUnread: number;
  readOnlyAccounts: string[];
  watermark: MailWatermark;
  /** The line under the name: the model's summary (`summaryBy: 'ai'`) or the newest unread subject. */
  summary?: string;
  summaryBy?: 'ai';
  /** Accounts in this group whose mail Walnut cannot move to an archive. */
  cannotArchive?: string[];
}

/** `on`: the model sorts new unread mail; `down`: it failed and the simple rules stand in; `off`: none. */
export interface MailAiStatus {
  state: 'on' | 'down' | 'off';
  pending: number;
}

export interface MailGroupsResponse {
  rulesRev: string;
  seq: number;
  recomputing?: { done: number; total: number };
  rulesError?: MailRulesError;
  ai: MailAiStatus;
  important: { total: number; unread: number };
  cachedTotal: number;
  cachedUnread: number;
  providerTotal: number;
  providerUnread: number;
  stale?: boolean;
  groups: MailGroupItem[];
}

export interface MailGroupsSummary {
  importantUnread: number;
  sortedUnread: number;
  pending: number;
  rulesRev: string;
}

export interface MailSortDto {
  group: MailGroupId;
  /** What the group is called (`Important` for Important). */
  label: string;
  reason: string;
  why: string;
  ruleId?: string;
}

export interface MailRuleWhen {
  from?: string | string[];
  subject?: string | { re: string };
  listId?: string;
  addressedToMe?: boolean;
  cc?: true;
  sender?: 'person' | 'bulk' | 'transactional' | 'automated' | 'unknown';
  account?: string;
  message?: string;
  /** Mail Walnut's model grouped under this name. */
  group?: string;
}

export interface MailRule {
  id?: string;
  when: MailRuleWhen;
  then: string;
  source: 'user' | 'learned';
  note?: string;
  created?: string;
  enabled?: boolean;
  label?: string;
  /** Keep the mail out of the Inbox: Walnut moves it to Archive as it arrives. */
  skipInbox?: boolean;
}

export interface MailRuleView extends MailRule { id: string; summary: string }

export interface MailCatalogItem { id: MailGroupId; label: string; source: 'reserved' | 'group' | 'rule' }

export interface MailRulesResponse {
  path: string;
  exists: boolean;
  rulesRev: string;
  fileRev: string;
  groups: string[];
  rules: MailRuleView[];
  builtins: Array<{ id: string; summary: string; then: string }>;
  catalog: MailCatalogItem[];
  error?: MailRulesError;
}

export interface MailRuleValidationError {
  index: number;
  field: string;
  message: string;
  line?: number;
  id?: string;
}

export interface MailSample {
  accountId: string;
  messageId: string;
  sender: string;
  subject: string;
  at: number;
  currentGroup: MailGroupId;
}

export interface MailShadow { ruleId: string; summary: string; mails: number }

export interface MailPreviewRequest {
  scope: MailGroupsScope;
  when: MailRuleWhen;
  then: string;
  insertAt?: number;
}

export interface MailPreviewResponse {
  matches: number;
  moves: number;
  samples: MailSample[];
  shadows: MailShadow[];
  recipientsKnown?: { known: number; of: number };
  partial?: boolean;
}

export type MailDraftKind = 'sender' | 'sender-subject' | 'sender-direct' | 'sender-not-direct' | 'message';

export interface MailProposeDraft {
  kind: MailDraftKind;
  when: MailRuleWhen;
  then: string;
  summary: string;
  label?: string;
  matches: number;
  moves: number;
  samples: MailSample[];
  shadows: MailShadow[];
}

export interface MailProposeResponse {
  drafts: MailProposeDraft[];
  recipients: { thisMail: 'known' | 'unknown'; known: number; of: number };
  model: {
    status: 'ok' | 'skipped' | 'unavailable' | 'invalid' | 'timeout';
    reason?: string;
    draft?: { when: MailRuleWhen; then: string; summary: string; matches: number; moves: number };
  };
}

export interface MailBulkJob {
  state: 'running' | 'done';
  kind: 'read' | 'unread';
  total: number;
  done: number;
  changedCount: number;
  failed: Array<{ accountId: string; messageId: string; reason: string }>;
  undoable: boolean;
  stopped?: boolean;
}

export interface MailUnsubscribePlanItem {
  listKey: string;
  keyedBy: 'list-id' | 'sender';
  label: string;
  accountId: string;
  messageId: string;
  method: 'one-click' | 'mailto' | 'link';
  mails: number;
  canSend: boolean;
  /** Only on a mailto the account cannot send: the address, for Copy and the mail app. */
  mailto?: string;
  done?: { at: number; method: string };
  attempt?: { status: string; at: number };
}

export interface MailUnsubscribePlan {
  items: MailUnsubscribePlanItem[];
  withoutOption: number;
  headerUnknown: number;
  unchecked?: number;
  partial?: boolean;
}

export interface MailUnsubscribeBatchItemState {
  accountId: string;
  messageId: string;
  method: string;
  status: 'queued' | 'running' | 'done' | 'needs-human' | 'failed' | 'skipped';
  message?: string;
  url?: string;
}

export interface MailUnsubscribeBatch {
  batchId: string;
  state: 'running' | 'done';
  stopped?: boolean;
  items: MailUnsubscribeBatchItemState[];
}

// ── wire helpers ──

/** Query form of a scope: `scope=role:inbox`, or `account=<id>&mailbox=<id>` (never both). */
export function mailGroupsScopeParams(scope: MailGroupsScope): Record<string, string> {
  return 'role' in scope
    ? { scope: `role:${scope.role}` }
    : { account: scope.accountId, mailbox: scope.mailboxId };
}

const seg = (value: string): string => encodeURIComponent(value);

// ── reads ──

export function getMailGroups(scope: MailGroupsScope): Promise<MailGroupsResponse> {
  return apiGet(`${BASE}/groups`, mailGroupsScopeParams(scope), QUIET);
}

/** The badge number and the digest's: Important unread over every inbox. */
export function getMailGroupsSummary(): Promise<MailGroupsSummary> {
  return apiGet(`${BASE}/groups/summary`, { scope: 'role:inbox' }, QUIET);
}

/** Rename a group; the person's name wins over the model's from then on. 400 carries the reason. */
export function renameMailGroup(groupId: MailGroupId, label: string): Promise<{ label: string }> {
  return apiPut(`${BASE}/groups/${seg(groupId)}/label`, { label });
}

// ── bulk read ──

export function markMailGroupRead(body: {
  scope: MailGroupsScope;
  group: MailGroupId;
  sender?: string;
  watermark: MailWatermark;
  rulesRev: string;
}): Promise<{ jobId: string; total: number }> {
  return apiPost(`${BASE}/groups/read`, body, QUIET);
}

/** Move a group's unread (inside the watermark) to Archive, under a keep-out-of-Inbox rule just saved. */
export function archiveMailGroup(body: {
  scope: MailGroupsScope;
  group: MailGroupId;
  watermark: MailWatermark;
  ruleId: string;
}): Promise<{ queued: number; skipped: number }> {
  return apiPost(`${BASE}/groups/archive`, body, QUIET);
}

export function getMailBulkJob(jobId: string): Promise<MailBulkJob> {
  return apiGet(`${BASE}/bulk/${seg(jobId)}`, undefined, { quietStatuses: [404] });
}

export function stopMailBulkJob(jobId: string): Promise<{ ok: boolean }> {
  return apiPost(`${BASE}/bulk/${seg(jobId)}/stop`, {}, QUIET);
}

export function undoMailBulkJob(jobId: string): Promise<{ jobId: string; total: number }> {
  return apiPost(`${BASE}/bulk/${seg(jobId)}/undo`, {}, QUIET);
}

export function retryMailBulkJob(jobId: string): Promise<{ jobId: string; total: number }> {
  return apiPost(`${BASE}/bulk/${seg(jobId)}/retry`, {}, QUIET);
}

// ── batch unsubscribe ──

export function getMailUnsubscribePlan(
  scope: MailGroupsScope,
  groupId: MailGroupId,
  check: boolean,
): Promise<MailUnsubscribePlan> {
  return apiGet(
    `${BASE}/groups/${seg(groupId)}/unsubscribe-plan`,
    { ...mailGroupsScopeParams(scope), check: check ? '1' : '0' },
    QUIET,
  );
}

export function startMailUnsubscribeBatch(
  items: Array<{ accountId: string; messageId: string; method: 'one-click' | 'mailto' | 'link' }>,
): Promise<{ batchId: string }> {
  return apiPost(`${BASE}/unsubscribe/batch`, { items }, QUIET);
}

export function stopMailUnsubscribeBatch(batchId: string): Promise<{ ok: boolean }> {
  return apiPost(`${BASE}/unsubscribe/batch/${seg(batchId)}/stop`, {}, QUIET);
}

export function getMailUnsubscribeBatch(batchId: string): Promise<MailUnsubscribeBatch> {
  return apiGet(`${BASE}/unsubscribe/batch/${seg(batchId)}`, undefined, { quietStatuses: [404] });
}

// ── rules ──

export function getMailRules(): Promise<MailRulesResponse> {
  return apiGet(`${BASE}/rules`, undefined, QUIET);
}

/** `baseRev` is the `fileRev` the caller last saw; 409 `changed` when the file moved since. */
export function putMailRules(body: {
  groups: string[];
  rules: MailRule[];
  baseRev: string;
  touch?: { accountId: string; messageId: string };
}): Promise<{ rulesRev: string; fileRev: string }> {
  return apiPut(`${BASE}/rules`, body);
}

export function initMailRules(): Promise<{ rulesRev: string; fileRev: string; path: string }> {
  return apiPost(`${BASE}/rules/init`, {}, QUIET);
}

export function restoreMailRules(): Promise<{ rulesRev: string; fileRev: string }> {
  return apiPost(`${BASE}/rules/restore`, {}, QUIET);
}

export function previewMailRule(body: MailPreviewRequest, signal?: AbortSignal): Promise<MailPreviewResponse> {
  return apiPost(`${BASE}/rules/preview`, body, { quietStatuses: [400, 409, 503], ...(signal ? { signal } : {}) });
}

export function proposeMailRule(body: {
  accountId: string;
  messageId: string;
  target: string;
  note?: string;
}): Promise<MailProposeResponse> {
  return apiPost(`${BASE}/rules/propose`, body, { ...QUIET, timeoutMs: 20_000 });
}

/** The server's copy of the Grouped / All mail switch (digest and triage read it). */
export function setMailGroupedPref(on: boolean): Promise<{ on: boolean }> {
  return apiPut(`${BASE}/groups/pref`, { on });
}
