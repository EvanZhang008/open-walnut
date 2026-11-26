/**
 * One decision shows once when two asks use other words, against a real server (src/core/same-ask-meaning.ts,
 * same-ask-tree.ts refuseSameAsk; 2026-11-25: a task asked the user in its status to sign in to an
 * account so a feature could ship, and its lead moved a card about the feature to needs asking the
 * same in its own words; the word test saw almost no shared words, and he had two cards).
 *
 * Every path that puts a decision before him while the experiment asks_same_by_meaning is on: a card
 * moved to needs (thread_update) and opened in needs (thread_create), a task's status ask set through
 * the report API (the reverse order: the lead's card asked first), a decision letter, a Board choice.
 * Only the fast model is stubbed (setMeaningJudgeOverride); the data is invented.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-same-ask-meaning'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { sameAskQuestionFor } from '../../src/core/same-ask-tree.js'
import { clearMeaningCache, setMeaningJudgeOverride } from '../../src/core/same-ask-meaning.js'

const SIGN_IN = 'Please sign in to the developer store account so the share feature can go to the beta channel.'
const SIGN_IN_OTHER_WORDS = 'Can you log in to the app store portal? The beta build of sharing waits on it.'
const KIND = { user_kind: 'credentials', user_kind_why: 'Only he holds the store account password' }
const MORE = { ask_more: 'The beta channel takes builds only from a signed-in developer account.' }

let base = ''
let n = 0
let leadId = ''
let leadSid = ''
let releaser: { id: string; sid: string }

/** The model's stand-in: SAME for the listed ask whose line holds `needle`, else NONE; every input kept. */
const judged: string[] = []
function sameAs(needle: string | null): void {
  setMeaningJudgeOverride(async (input) => {
    judged.push(input)
    if (!needle) return 'NONE'
    const m = input.split('\n').map((l) => /^(\d+)\. From .*$/.exec(l)).find((x) => x && x[0].includes(needle))
    return m ? `SAME: ${m[1]}` : 'NONE'
  })
}

async function task(title: string, parent = leadId): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: 'Orchard', parent_task_id: parent } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-eeee-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  return { id, sid }
}

/** Its turn ended asking the user `ask` (what the status question stores). */
async function asks(id: string, ask: string): Promise<void> {
  await updateTask(id, { phase: 'NEED_ACTION' })
  await updateTaskRaw(id, { status_report: { state: 'needs', ask, ask_own: { kind: 'credentials', why: 'His password' }, at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function call(method: string, url: string, body: unknown, callerSid?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, body: JSON.stringify(body),
  })
}
const setSwitch = async (on: boolean) => expect((await call('PUT', '/api/config', { experimental: { asks_same_by_meaning: on } })).status).toBe(200)

/** A card of the lead's, opened answered (nothing handed to him yet). */
async function answeredCard(title: string, text: string): Promise<string> {
  const res = await call('POST', `/api/v1/tasks/${leadId}/threads/open`, { title, text, from: 'task', state: 'answered' }, leadSid)
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { thread: { id: string } }).thread.id
}
const stateOf = async (tid: string) => (await readThreads(leadId)).threads.find((t) => t.id === tid)?.state
/** He drops the card (his own close), so it waits on him no more. */
const drop = async (tid: string) => expect((await call('PATCH', `/api/v1/tasks/${leadId}/threads/${tid}`, { close: 'dropped' })).status).toBe(200)
const SEPARATE = { separate_reason: 'Each card here is its own decision for him' }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Orchard')).id
  leadSid = 'ffffffff-eeee-4bbb-8ccc-dddddddddddd'
  await createSessionRecord(leadSid, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(leadSid, { process_status: 'stopped' } as never)
  releaser = await task('Share feature release')
  await asks(releaser.id, SIGN_IN)
  await setSwitch(true)
})

afterAll(async () => {
  setMeaningJudgeOverride(null)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { clearMeaningCache(); judged.length = 0 })

describe('the incident: the task asks first, its lead moves a card about the feature to needs', () => {
  let card = ''

  it('the words share almost nothing, so the word test alone lets it through today', async () => {
    expect((await getTask(releaser.id)).user_status).toMatchObject({ state: 'needs', ask: SIGN_IN })
    await setSwitch(false)
    sameAs('developer store account')
    const tid = await answeredCard('Share feature beta', 'The share feature is ready for the beta channel')
    const moved = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${tid}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'Sharing is built; the beta waits on the store portal.', ...KIND }, leadSid)
    expect(moved.status, await moved.clone().text()).toBe(200)
    // Off: no model call.
    expect(judged).toEqual([])
    // Back out of his sight for the next case.
    await drop(tid)
    await setSwitch(true)
  })

  it('the model says SAME: 409 same_ask naming the task\'s ask, and nothing is written', async () => {
    sameAs('developer store account')
    card = await answeredCard('Share feature beta rollout', 'The share feature is ready for the beta channel')
    const moved = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${card}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'Sharing is built; the beta waits on the store portal.', ...KIND }, leadSid)
    expect(moved.status).toBe(409)
    const why = JSON.stringify(await moved.json())
    expect(why).toContain('same_ask')
    expect(why).toContain(releaser.id)
    expect(why).toContain('developer store account')
    expect(why).toContain('a model judged it the same decision')
    expect(await stateOf(card)).toBe('answered')
    // It read the task's status ask and the card's own words, once.
    expect(judged).toHaveLength(1)
    expect(judged[0]).toContain(SIGN_IN)
    expect(judged[0]).toContain('log in to the app store portal')
  })

  it('a retry of the same write is refused again with no second model call', async () => {
    sameAs('developer store account')
    const first = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${card}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'Sharing is built; the beta waits on the store portal.', ...KIND }, leadSid)
    expect(first.status).toBe(409)
    const again = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${card}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'Sharing is built; the beta waits on the store portal.', ...KIND }, leadSid)
    expect(again.status).toBe(409)
    expect(judged).toHaveLength(1)
  })

  it('ask_owner leaves the decision to the task: the write goes through', async () => {
    sameAs('developer store account')
    const owned = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${card}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'Sharing is built; the beta waits on the store portal.', ask_owner: releaser.id, ...KIND }, leadSid)
    expect(owned.status, await owned.clone().text()).toBe(200)
    expect((await readThreads(leadId)).threads.find((t) => t.id === card)?.askOwner?.task).toBe(releaser.id)
  })

  it('a card opened in needs is checked the same way; same_ask_reason skips the model', async () => {
    sameAs('developer store account')
    const open = { title: 'Beta channel for sharing', text: 'Log in to the app store portal so the sharing beta can ship?', from: 'task', ...KIND, ...SEPARATE }
    const refused = await call('POST', `/api/v1/tasks/${leadId}/threads/open`, open, leadSid)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain(releaser.id)
    judged.length = 0
    const reasoned = await call('POST', `/api/v1/tasks/${leadId}/threads/open`, { ...open, same_ask_reason: 'It asks for the store team account, not his own' }, leadSid)
    expect(reasoned.status, await reasoned.clone().text()).toBe(201)
    expect(judged).toEqual([])
    const tid = ((await reasoned.json()) as { thread: { id: string } }).thread.id
    await drop(tid)
  })

  it('the model says NONE: it goes through', async () => {
    sameAs(null)
    const tid = await answeredCard('Fence posts', 'The north fence needs new posts')
    const moved = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${tid}`, { state: 'needs', ask: 'Order larch posts or oak posts for the north fence?', reply: 'Larch is cheaper; oak lasts longer.', user_kind: 'spending', user_kind_why: 'It buys fence posts', ...SEPARATE }, leadSid)
    expect(moved.status, await moved.clone().text()).toBe(200)
    expect(judged).toHaveLength(1)
    await drop(tid)
  })

  it('no model (none set up, background AI off in a test process): today\'s behaviour, it goes through', async () => {
    setMeaningJudgeOverride(null)
    const tid = await answeredCard('Share feature store login', 'The share feature is ready for the beta channel')
    const moved = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${tid}`, { state: 'needs', ask: SIGN_IN_OTHER_WORDS, reply: 'The beta waits on the store portal.', ...KIND, ...SEPARATE }, leadSid)
    expect(moved.status, await moved.clone().text()).toBe(200)
    await drop(tid)
  })
})

describe('the reverse order: the lead\'s card asks first, then a task below it asks in its status', () => {
  let card = ''
  let heater: { id: string; sid: string }

  beforeAll(async () => {
    sameAs(null)
    card = await answeredCard('Greenhouse winter', 'Winter planning for the greenhouse')
    const moved = await call('PATCH', `/api/v1/tasks/${leadId}/threads/${card}`, { state: 'needs', ask: 'Should we buy the larger greenhouse heater before the frost?', reply: 'The small heater cannot hold 5 C at night.', user_kind: 'spending', user_kind_why: 'It buys a heater', ...SEPARATE }, leadSid)
    expect(moved.status, await moved.clone().text()).toBe(200)
    heater = await task('Greenhouse climate')
  })

  it('the model says SAME: the task\'s status ask is refused, naming the lead\'s card', async () => {
    sameAs('larger greenhouse heater')
    const res = await call('PUT', `/api/v1/tasks/${heater.id}/report`, { state: 'needs', ask: 'Approve spending on a bigger heating unit for the glasshouse this winter?', ...MORE, user_kind: 'spending', user_kind_why: 'It buys a heater' }, heater.sid)
    expect(res.status).toBe(409)
    const why = JSON.stringify(await res.json())
    expect(why).toContain('same_ask')
    expect(why).toContain(leadId)
    expect(why).toContain(card)
    expect(why).toContain('Greenhouse winter')
    expect((await getTask(heater.id)).status_report?.state).not.toBe('needs')
    expect(judged[0]).toContain('a card on its Threads "Greenhouse winter"')
  })

  it('same_ask_reason says it is another decision: it goes, with no model call', async () => {
    sameAs('larger greenhouse heater')
    const res = await call('PUT', `/api/v1/tasks/${heater.id}/report`, { state: 'needs', ask: 'Approve spending on a bigger heating unit for the glasshouse this winter?', ...MORE, user_kind: 'spending', user_kind_why: 'It buys a heater', same_ask_reason: 'It asks for the spare unit, not the main heater' }, heater.sid)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(judged).toEqual([])
    // Its own ask written again later is not judged again: it was judged when it was new.
    const again = await call('PUT', `/api/v1/tasks/${heater.id}/report`, { state: 'needs', ask: 'Approve spending on a bigger heating unit for the glasshouse this winter?', ...MORE, user_kind: 'spending', user_kind_why: 'It buys a heater' }, heater.sid)
    expect(again.status, await again.clone().text()).toBe(200)
    expect(judged).toEqual([])
  })

  it('the turn-end status question lists the lead\'s card, so the session judges it too', async () => {
    const q = await sameAskQuestionFor(heater.id)
    expect(q).toContain(`[${leadId}]`)
    expect(q).toContain('its card "Greenhouse winter" on its Threads')
    expect(q).toContain('larger greenhouse heater')
    await setSwitch(false)
    expect(await sameAskQuestionFor(heater.id)).not.toContain('Greenhouse winter')
    await setSwitch(true)
  })
})

describe('a decision letter and a Board choice', () => {
  let sibling: { id: string; sid: string }
  beforeAll(async () => { sibling = await task('Share feature store listing') })

  it('a letter asking the task\'s sign-in in other words is refused; NONE sends it', async () => {
    sameAs('developer store account')
    const letter = { type: 'action_required', subject: 'Log in to the app store portal for the sharing beta?', markdown: 'The store listing is drafted; the beta needs the portal session.', actions: [{ id: 'done', label: 'I logged in' }, { id: 'later', label: 'Later today' }], ...KIND }
    const sent = await call('POST', '/api/v1/human-inbox', letter, sibling.sid)
    expect(sent.status).toBe(409)
    expect(JSON.stringify(await sent.json())).toMatch(/same_ask[\s\S]*Share feature release[\s\S]*a model judged it/)
    expect(judged[0]).toContain('the beta needs the portal session')
    sameAs(null)
    const other = await call('POST', '/api/v1/human-inbox', { ...letter, subject: 'Pick the store listing screenshots?', markdown: 'Three sets are drafted.', actions: [{ id: 'a', label: 'Set A' }, { id: 'b', label: 'Set B' }], user_kind: 'outward', user_kind_why: 'The listing is published under his name' }, sibling.sid)
    expect(other.status, await other.clone().text()).toBe(201)
  })

  it('a Board choice asking it in other words is refused; NONE adds it', async () => {
    sameAs('developer store account')
    const html = (title: string) => `<html><body><h1>Store</h1><walnut-choice id="pick1" title="${title}" options="now:Log in now,later:Log in tonight"></walnut-choice></body></html>`
    const refused = await call('PUT', `/api/v1/tasks/${sibling.id}/board`, { html: html('When will you open the store portal session for the sharing beta?') }, sibling.sid)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toMatch(/Choice not added[\s\S]*a model judged it/)
    expect(judged[0]).toContain('Log in tonight')
    sameAs(null)
    const added = await call('PUT', `/api/v1/tasks/${sibling.id}/board`, { html: html('Ship the store listing in English only, or with French too?') }, sibling.sid)
    expect(added.status, await added.clone().text()).toBe(200)
  })
})
