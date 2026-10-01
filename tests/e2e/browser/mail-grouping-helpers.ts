/**
 * Helpers for the inbox-sorting specs (`mail-grouping*.spec.ts`), on the `PW_MAIL_GROUPS` fixture.
 *
 * Every API call here goes to `http://localhost:${fixture.port}`: the fixture server this spec
 * started, never the Playwright baseURL (that one is ANOTHER fixture with other mail). The
 * `/__fixture/*` endpoints are the mail server's own records (flags, the mark-read log, header
 * fetches, unsubscribe requests, model calls); the `/api/plugins/mail/*` ones are the product.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'
import { folderRow, MailFixtureServer, PANE, openMail, shellUp, smartRow, type MailFixture } from './mail-review-helpers'
import {
  CHANGE_DESK, CHANGE_DESK_MAILS, EXPECTED_BUILTIN, FERRY, FERRY_ADDRESS, IMPORTANT_BUILTINS, MAILTO_LIST_ID, MARINA,
  MARINA_ADDRESS, OWN_NAME, ROW, UNSUB_TARGET_HOST,
} from './fixtures/mail-fixture-provider/groups-set.mjs'

export {
  CHANGE_DESK, CHANGE_DESK_MAILS, EXPECTED_BUILTIN, FERRY, FERRY_ADDRESS, IMPORTANT_BUILTINS, MAILTO_LIST_ID, MARINA,
  MARINA_ADDRESS, OWN_NAME, ROW, UNSUB_TARGET_HOST,
}

export type GroupsScope = { role: 'inbox' } | { accountId: string; mailboxId: string }
export const ALL_INBOXES: GroupsScope = { role: 'inbox' }
export const MARINA_INBOX: GroupsScope = { accountId: MARINA, mailboxId: 'INBOX' }
export const FERRY_INBOX: GroupsScope = { accountId: FERRY, mailboxId: 'INBOX' }

export type LabelMode = 'ok' | 'down' | 'invalid' | 'partial' | 'slow'

/**
 * Start a grouping fixture. `dense: true` is the 1,500-per-account set; `ruleModel` picks the faked
 * rule model (`down` when unset); `labelModel` the faked labeling model (`ok` when unset, groups-
 * labeler.mjs). Extra env rides along (for example `PW_MAIL_DIGEST_OFF`).
 */
export async function startGroupsFixture(
  options: { dense?: boolean; ruleModel?: 'canned' | 'invalid' | 'down' | 'slow'; labelModel?: LabelMode; env?: Record<string, string> } = {},
): Promise<{ server: MailFixtureServer; fixture: MailFixture }> {
  const server = new MailFixtureServer()
  const fixture = await server.start({
    PW_MAIL_DENSE: '0',
    ...(options.dense ? { PW_MAIL_GROUPS_DENSE: '1' } : { PW_MAIL_GROUPS: '1' }),
    PW_MAIL_RULE_MODEL: options.ruleModel ?? 'down',
    PW_MAIL_LABEL_MODEL: options.labelModel ?? 'ok',
    ...(options.env ?? {}),
  })
  return { server, fixture }
}

const base = (fixture: MailFixture) => `http://localhost:${fixture.port}`

async function json<T>(response: Response): Promise<T> {
  const text = await response.text()
  try { return JSON.parse(text) as T } catch { throw new Error(`not JSON (${response.status}): ${text.slice(0, 200)}`) }
}

export async function api<T = any>(fixture: MailFixture, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base(fixture)}/api/plugins/mail${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  })
  return { status: response.status, body: await json<T>(response) }
}

async function fixtureCall<T = any>(fixture: MailFixture, path: string, method = 'GET'): Promise<T> {
  return json<T>(await fetch(`${base(fixture)}/__fixture/${path}`, { method }))
}

export function scopeQuery(scope: GroupsScope): string {
  return 'role' in scope
    ? 'scope=role:inbox'
    : `account=${encodeURIComponent(scope.accountId)}&mailbox=${encodeURIComponent(scope.mailboxId)}`
}

export async function getGroups(fixture: MailFixture, scope: GroupsScope = ALL_INBOXES): Promise<any> {
  const { status, body } = await api(fixture, `/groups?${scopeQuery(scope)}`)
  if (status !== 200) throw new Error(`GET /groups answered ${status}: ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

/** Every cached row of one group in a scope, paged to the end through the product's own list route. */
export async function allGroupMessages(
  fixture: MailFixture, group: string, scope: GroupsScope = ALL_INBOXES, options: { sender?: string; unread?: boolean } = {},
): Promise<any[]> {
  const rows: any[] = []
  let before = ''
  for (let page = 0; page < 200; page += 1) {
    const query = [scopeQuery(scope), `group=${encodeURIComponent(group)}`, 'limit=200',
      ...(options.sender ? [`sender=${encodeURIComponent(options.sender)}`] : []),
      ...(options.unread ? ['unread=1'] : []), ...(before ? [`before=${encodeURIComponent(before)}`] : [])]
    const { status, body } = await api(fixture, `/messages?${query.join('&')}`)
    if (status !== 200) throw new Error(`GET /messages answered ${status}: ${JSON.stringify(body).slice(0, 200)}`)
    rows.push(...(body.messages ?? []))
    if (!body.nextBefore) break
    before = typeof body.nextBefore === 'string' ? body.nextBefore : JSON.stringify(body.nextBefore)
  }
  return rows
}

// The fixture server's own records.

/**
 * New unread mail (newest of all), `people` of them from a person writing to Robin directly;
 * `kind: 'list'` makes the rest a newsletter whose only way out is a mailto:.
 */
export function deliver(fixture: MailFixture, count = 1, options: { people?: number; account?: 'marina' | 'ferry'; kind?: 'list' } = {}): Promise<{ delivered: Array<{ accountId: string; messageId: string; subject: string }> }> {
  const query = `count=${count}&people=${options.people ?? 0}&account=${options.account ?? 'marina'}${options.kind ? `&kind=${options.kind}` : ''}`
  return fixtureCall(fixture, `deliver?${query}`, 'POST')
}

/** The Nth read-flag change from now, and the `count - 1` after it, fail on the mail server. */
export function failMarkRead(fixture: MailFixture, after: number, count: number): Promise<{ failRule: unknown }> {
  return fixtureCall(fixture, `fail-mark-read?after=${after}&count=${count}`, 'POST')
}

export interface MarkReadEntry { accountId: string; messageId: string; read: boolean; via: 'markRead' | 'markReadMany'; ordinal: number; ok: boolean; at: number }
export function markReadLog(fixture: MailFixture): Promise<{ calls: number; log: MarkReadEntry[] }> {
  return fixtureCall(fixture, 'mark-read-log')
}

/** The mail server's own `\Seen` for one message. */
export function flags(fixture: MailFixture, accountId: string, messageId: string): Promise<{ known: boolean; seen: boolean; flags: string[] }> {
  return fixtureCall(fixture, `flags?account=${encodeURIComponent(accountId)}&message=${encodeURIComponent(messageId)}`)
}

export function unsubLog(fixture: MailFixture): Promise<{ calls: number; log: Array<{ kind: 'https' | 'mailto'; url?: string; method?: string; to?: string[] }> }> {
  return fixtureCall(fixture, 'unsub-log')
}

/** How long each unsubscribe target takes to answer, so a spec can act while a batch is running. */
export function setUnsubDelay(fixture: MailFixture, ms: number): Promise<{ ok: boolean; ms: number }> {
  return fixtureCall(fixture, `unsub-delay?ms=${ms}`, 'POST')
}

export function headerFetchLog(fixture: MailFixture): Promise<{ calls: number; log: Array<{ messageId: string; peek: boolean; seenBefore: boolean }> }> {
  return fixtureCall(fixture, 'header-fetch-log')
}

export function modelCalls(fixture: MailFixture): Promise<{ calls: number; log: Array<{ mode: string; user: string }> }> {
  return fixtureCall(fixture, 'model-calls')
}

/** How the faked labeling model answers from now on (the fixture keeps it across calls). */
export function setLabelModel(fixture: MailFixture, mode: LabelMode): Promise<{ mode: LabelMode }> {
  return fixtureCall(fixture, `label-model?mode=${mode}`, 'POST')
}

/** Every call to the faked labeling model since the last `resetLogs`. */
export function labelCalls(fixture: MailFixture): Promise<{ calls: number; log: Array<{ mode: string; user: string }> }> {
  return fixtureCall(fixture, 'label-calls')
}

/** ferry's per-message read latency (default 40 ms): raise it to make a Stop test deterministic. */
export function setFerryReadDelay(fixture: MailFixture, ms: number): Promise<{ ms: number }> {
  return fixtureCall(fixture, `read-delay?ms=${ms}`, 'POST')
}

export function resetLogs(fixture: MailFixture): Promise<{ ok: boolean }> {
  return fixtureCall(fixture, 'reset-logs', 'POST')
}

// The rules file.

/** The rules file's absolute path, as the server resolves it (`GET /rules`). */
export async function rulesPath(fixture: MailFixture): Promise<string> {
  const { status, body } = await api<{ path: string }>(fixture, '/rules')
  if (status !== 200 || !body.path) throw new Error(`GET /rules answered ${status}`)
  return body.path
}

/** The file's text, or `null` when it does not exist. */
export async function readRulesFile(fixture: MailFixture): Promise<string | null> {
  try { return await fs.readFile(await rulesPath(fixture), 'utf8') } catch { return null }
}

/** Write the rules file by hand (the watcher picks it up within about a second, or 5 s at worst). */
export async function writeRulesFile(fixture: MailFixture, text: string): Promise<string> {
  const file = await rulesPath(fixture)
  await fs.writeFile(file, text, 'utf8')
  return file
}

/** sha256 of the file's bytes (empty string when absent), to prove a flow did or did not write it. */
export async function fileHash(fixture: MailFixture): Promise<string> {
  const text = await readRulesFile(fixture)
  return text === null ? '' : crypto.createHash('sha256').update(text).digest('hex')
}

/** Wait until `GET /groups` reports no recompute in flight (after a rules change). */
export async function waitSorted(fixture: MailFixture, scope: GroupsScope = ALL_INBOXES, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const groups = await getGroups(fixture, scope)
    if (!groups.recomputing && !groups.stale) return groups
    if (Date.now() > deadline) throw new Error(`groups still recomputing after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Wait until the model has labeled every unread mail it will label (`ai.pending` is 0). */
export async function waitLabeled(fixture: MailFixture, scope: GroupsScope = ALL_INBOXES, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const groups = await getGroups(fixture, scope)
    if (!groups.recomputing && !groups.stale && groups.ai.pending === 0) return groups
    if (Date.now() > deadline) throw new Error(`still ${groups.ai.pending} mails to label after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Poll a bulk job until it is done. */
export async function waitBulkJob(fixture: MailFixture, jobId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { status, body } = await api(fixture, `/bulk/${encodeURIComponent(jobId)}`)
    if (status === 200 && body.state === 'done') return body
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} not done after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// The grouped list on screen.

export function groupLine(page: Page, id: string): Locator {
  return page.locator(`[data-testid="mail-group-row"][data-group-id="${id}"]`)
}

export function mailRow(page: Page, accountId: string, messageId: string): Locator {
  return page.locator(`[data-testid="mail-row"][data-account-id="${accountId}"][data-message-id="${messageId}"]`)
}

/** One line of the list status strip (`mail-list-status`), by its words. */
export function statusLine(page: Page, text: RegExp): Locator {
  return page.getByTestId('mail-list-status').locator('.mail-list-status-line').filter({ hasText: text })
}

/** Open Mail, pick one inbox (or All Inboxes), and wait for the grouped list to draw its groups. */
/**
 * Into Mail through the sidebar at any width. Under 1100px the console shows ONE pane, and something
 * is always selected (the console picks an inbox), so the folder list is reached through the list's
 * Mailboxes control, as a person at that width reaches it.
 */
export async function openMailAnyWidth(page: Page, port: number): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1100) return openMail(page, port)
  await shellUp(page, port)
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-mail').click()
  // The folder list can flash before the console's own pick lands; the list (and its back) is where
  // the console settles.
  const back = page.getByTestId('mail-show-mailboxes')
  await expect(back).toBeVisible({ timeout: 90_000 })
  await back.click()
  await expect(page.locator(PANE)).toBeVisible()
}

export async function openGrouped(page: Page, fixture: MailFixture, accountId: string | null = null): Promise<void> {
  await openMailAnyWidth(page, fixture.port)
  if (accountId) await folderRow(page, accountId, 'INBOX').click()
  else await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-grouped')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mail-group-row').first()).toBeVisible({ timeout: 60_000 })
}

/** Open one group line (a click on its name) and wait for its first rows. */
export async function openGroupLine(page: Page, id: string): Promise<Locator> {
  const line = groupLine(page, id)
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.getByTestId('mail-group-name').click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  const group = page.locator(`[data-testid="mail-group"][data-group-id="${id}"]`)
  await expect(group.locator('[data-testid="mail-row"]').first()).toBeVisible({ timeout: 20_000 })
  return group
}

/** The group's more (...) menu (the tools show on hover; the pointer goes there first, as a person's would). */
export async function openGroupMenu(page: Page, id: string): Promise<Locator> {
  const line = groupLine(page, id)
  await line.hover()
  await line.getByTestId('mail-group-more').click()
  const menu = page.getByTestId('mail-group-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** The group a message sits in, as the product's own list route says (`important` or a group id). */
export async function groupOfMessage(fixture: MailFixture, accountId: string, messageId: string): Promise<string | null> {
  const groups = await getGroups(fixture, ALL_INBOXES)
  for (const id of ['important', ...groups.groups.map((one: { id: string }) => one.id)]) {
    const rows = await allGroupMessages(fixture, id)
    if (rows.some((one) => one.accountId === accountId && one.messageId === messageId)) return id
  }
  return null
}

/** Parses the saved rules file's rules (js-yaml is a repo dependency). */
export async function fileRules(fixture: MailFixture): Promise<any[]> {
  const text = await readRulesFile(fixture)
  if (text === null) return []
  const yaml = await import('js-yaml')
  const doc = yaml.load(text) as { rules?: any[] } | null
  return doc?.rules ?? []
}
