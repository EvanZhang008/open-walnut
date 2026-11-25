/**
 * What the Threads hold matrix changes above the card he reads (threads-hold-matrix.spec.ts), and
 * the writes that make each change: a thread the node opens, his Acknowledge, a card moved and put
 * back. CHANGES is the matrix's columns; ABOVE_A_CARD and GROUPS_ABOVE name the change for every
 * element and group a Threads list draws (tests/web/threads-hold.test.ts reads them from this file).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import type { Pos } from './threads-hold-page'

export const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
export const WHY = { user_kind: 'user_own', user_kind_why: 'It is his own garden.' }
/** Each row is its own decision (the server folds one matter asked twice). */
export const SEPARATE = { separate_reason: 'Each garden row is its own decision.' }
let n = 0

export interface Node { task: string; sid: string }
export interface Ctx { page: Page; request: APIRequestContext; node: Node; target: string | null; targetGroup: string | null; box: string }
/** A card on the page: its id, and the Watching copy it is (null for the card in its own group). */
export interface CardRef { id: string; copy: string | null }
export interface Run {
  done: () => Promise<boolean>
  cleanup?: () => Promise<void>
  /** After the change he leaves the list (the pointer goes, the box is left): a failure says what is wrong. */
  leave?: (at: { pos: Pos; y0: number }) => Promise<string | null>
}
export interface Change {
  name: string
  /** Which surface draws it: the plain list has no groups, folds or lines. */
  on: ReadonlyArray<'pane' | 'rail'>
  /** It acts on the card right above the one he reads. */
  target?: boolean
  /**
   * It acts on the card he reads itself: the card that stood right before it (else right after it;
   * away, the one after it first) is the one judged, the place he was reading. Typing, the box he
   * typed in goes with the card, so only the place is judged.
   */
  self?: boolean
  /** He reads a card of this group (the rail): a folded group's head only stands above an opened fold's cards. */
  readIn?: string
  /** Not at the very top: nothing of the kind can stand above a card there. */
  scrolledOnly?: boolean
  run: (c: Ctx) => Promise<Run>
}

export async function call<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

export const longReply = (k: number, lines = 4) => Array.from({ length: lines }, (_, i) => `Row ${k}, check ${i + 1}: the soil is moist, the seedlings are up and the netting holds against the birds.`).join('\n')

/** The node opens a thread for him: answered (Done), needs (Needs you) or working. */
export async function nodeThread(request: APIRequestContext, node: Node, state: 'answered' | 'needs' | 'working' = 'answered', title = `Row ${++n} ${STAMP}`): Promise<string> {
  const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${node.task}/threads/open`, { title, text: `${title}: where it stands.`, from: 'node', state: state === 'working' ? 'answered' : state, ...(state === 'needs' ? { ...WHY, ...SEPARATE } : {}) }, node.sid)
  const reply = state === 'needs' ? `Net the row now or in May? ${STAMP}` : longReply(n, state === 'answered' ? 4 : 1)
  await call(request, 'patch', `/api/v1/tasks/${node.task}/threads/${thread.id}`, { reply, state, ...(state === 'needs' ? { ...WHY, ...SEPARATE } : {}) }, node.sid)
  return thread.id
}
export const patchThread = (c: Ctx, id: string, data: Record<string, unknown>, asHim = false) =>
  call(c.request, 'patch', `/api/v1/tasks/${c.node.task}/threads/${id}`, data, asHim ? undefined : c.node.sid)
/** His own Acknowledge: the card leaves with no line (thread-moves.ts), so a cleanup leaves nothing to fade. Done once it is gone. */
export const ack = async (c: Ctx, id: string) => {
  await patchThread(c, id, { close: 'acked' }, true)
  await expect.poll(() => c.page.locator(`${c.box} [data-testid="org-thread"][data-thread-id="${id}"]`).count(), { timeout: 15_000 }).toBe(0)
}
export const sel = (box: string, id: string) => `${box} [data-testid="org-thread"][data-thread-id="${id}"]:not([data-copy])`
export const selRef = (box: string, r: CardRef) => (r.copy ? `${box} [data-testid="org-thread"][data-thread-id="${r.id}"][data-copy="${r.copy}"]` : sel(box, r.id))
export const present = (c: Ctx, id: string) => async () => (await c.page.locator(sel(c.box, id)).count()) === 1
export const gone = (c: Ctx, id: string) => async () => (await c.page.locator(sel(c.box, id)).count()) === 0
/** The card a change moved away back in its own group, so the next cells read a list of the same density (the whole matrix drained Done). */
export const restore = async (c: Ctx, id: string) => {
  const own = c.targetGroup === 'needs' ? { state: 'needs', ...WHY, ...SEPARATE, reply: `Net the row now or in May? ${STAMP}` } : { state: 'answered', reply: longReply(n) }
  await patchThread(c, id, own)
  const group = c.targetGroup === 'needs' ? 'needs' : 'read'
  const back = c.page.locator(`${c.box} [data-testid="org-thread"][data-thread-id="${id}"]:not([data-copy])`)
  await expect.poll(async () => (await back.count()) === 1 && (c.targetGroup === null || (await back.evaluate((el, g) => !el.closest('[data-testid="org-thread-group"]') || el.closest<HTMLElement>('[data-testid="org-thread-group"]')!.dataset.group === g, group))), { timeout: 15_000 }).toBe(true)
}

/** Where a card stands in the box: in view or not, and the box's scroll. */
export const placeIn = (c: Ctx, id: string) => c.page.evaluate(({ box, s }) => {
  const b = document.querySelector<HTMLElement>(box)!
  const el = document.querySelector(s)
  const r = el?.getBoundingClientRect()
  const br = b.getBoundingClientRect()
  return { scrollTop: b.scrollTop, inView: !!r && r.bottom > br.top + 1 && r.top < br.bottom - 1, top: r?.top ?? NaN }
}, { box: c.box, s: sel(c.box, id) })

/** The card `c.target` goes from Needs you to Done, or from Done to Needs you. */
export async function toOtherGroup(c: Ctx): Promise<Run> {
  const to = c.targetGroup === 'needs' ? 'answered' : 'needs'
  await patchThread(c, c.target!, { state: to, ...(to === 'needs' ? { ...WHY, ...SEPARATE, reply: `Net it now or in May? ${STAMP}` } : { reply: longReply(n) }) })
  const now = to === 'needs' ? 'needs' : 'read'
  return {
    done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread-group"][data-group="${now}"] [data-thread-id="${c.target}"]:not([data-copy])`).count()) === 1,
    cleanup: () => restore(c, c.target!),
  }
}

export const CHANGES: Change[] = [
  {
    name: 'new card in a group above', on: ['pane', 'rail'],
    run: async (c) => { const id = await nodeThread(c.request, c.node, 'needs'); return { done: present(c, id), cleanup: () => ack(c, id) } },
  },
  {
    // The reviewer's case: held out of view above while he read at the very top, it stayed hidden once he left.
    name: 'a new card above, then he leaves', on: ['pane', 'rail'],
    run: async (c) => {
      const id = await nodeThread(c.request, c.node, 'needs')
      return {
        done: present(c, id),
        cleanup: () => ack(c, id),
        leave: async ({ pos }) => {
          const at = await placeIn(c, id)
          if (pos === 'top') return at.scrollTop < 1 && at.inView ? null : `back at the top with the new card in view (scrollTop ${at.scrollTop}, in view ${at.inView})`
          return null
        },
      }
    },
  },
  {
    name: 'new card in his group', on: ['pane', 'rail'],
    run: async (c) => { const id = await nodeThread(c.request, c.node, 'answered'); return { done: present(c, id) } },
  },
  {
    name: 'a card is watched (Watching, above all)', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      await patchThread(c, c.target!, { watch: true })
      return {
        done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread"][data-copy="watching"][data-thread-id="${c.target}"]`).count()) === 1,
        cleanup: async () => {
          await patchThread(c, c.target!, { watch: false })
          await expect.poll(() => c.page.locator(`${c.box} [data-testid="org-thread"][data-copy="watching"][data-thread-id="${c.target}"]`).count(), { timeout: 15_000 }).toBe(0)
        },
      }
    },
  },
  {
    name: 'a card above grows', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      const words = `Grown ${++n} ${STAMP}`
      const keep = c.targetGroup === 'needs' ? { state: 'needs', ...WHY, ...SEPARATE } : { state: 'answered' }
      await patchThread(c, c.target!, { reply: `${words}\n${longReply(n, 6)}`, ...keep })
      return {
        done: async () => (await c.page.locator(`${sel(c.box, c.target!)} [data-testid="org-thread-reply"]`).textContent({ timeout: 2_000 }).catch(() => ''))?.includes(words) ?? false,
        // Short again, so the next cells read a list of the same density; done once it is drawn short.
        cleanup: async () => {
          await patchThread(c, c.target!, { reply: c.targetGroup === 'needs' ? `Net the row now or in May? ${STAMP}` : longReply(n), ...keep })
          await expect.poll(async () => (await c.page.locator(`${sel(c.box, c.target!)} [data-testid="org-thread-reply"]`).textContent({ timeout: 2_000 }).catch(() => words))?.includes(words) ?? true, { timeout: 15_000 }).toBe(false)
        },
      }
    },
  },
  {
    // Out of the open list (the pane) or into a fold with a line in its place (the rail).
    name: 'a card above leaves', on: ['pane', 'rail'], target: true,
    run: async (c) => { await patchThread(c, c.target!, { state: 'pending' }); return { done: gone(c, c.target!), cleanup: () => restore(c, c.target!) } },
  },
  {
    name: 'its move line fades', on: ['rail'], target: true,
    run: async (c) => {
      const line = c.page.locator(`${c.box} [data-testid="org-thread-move-note"]`)
      // runCell moved it out first (its line is what fades).
      return { done: async () => (await line.count()) === 0, cleanup: () => restore(c, c.target!) }
    },
  },
  {
    name: 'a card above moves to another group', on: ['rail'], target: true,
    run: (c) => toOtherGroup(c),
  },
  // 2026-11-25, a review: the card he reads (a Needs you card he answers) goes to Done, and with it
  // the hold let go with no correction, so every card he saw moved by its new height. At the end of
  // the range the list gets shorter below the place he read: the box keeps room at its bottom.
  {
    name: 'the card he reads moves to another group', on: ['rail'], self: true, readIn: 'needs',
    run: (c) => toOtherGroup(c),
  },
  {
    name: 'a folded group above gets its first card', on: ['rail'], readIn: 'waiting', scrolledOnly: true,
    run: async (c) => {
      const id = await nodeThread(c.request, c.node, 'working')
      return {
        done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread-group"][data-group="working"]`).count()) === 1,
        cleanup: () => ack(c, id),
      }
    },
  },
  {
    // The read after a reconnect brings what changed while the link was down (a new card, a grown one).
    name: 'the list is read again after a reconnect', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      const url = `/api/v1/tasks/${c.node.task}/threads`
      const stale = await (await c.request.get(url)).text()
      const route = `**${url}`
      await c.page.route(route, (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: stale }) : r.continue()))
      const id = await nodeThread(c.request, c.node, 'needs')
      const fresh = await nodeThread(c.request, c.node, 'answered')
      await patchThread(c, c.target!, { reply: `Reconnected ${STAMP}\n${longReply(n, 7)}`, state: c.targetGroup === 'needs' ? 'needs' : 'answered', ...(c.targetGroup === 'needs' ? { ...WHY, ...SEPARATE } : {}) })
      await c.page.waitForTimeout(800)
      await c.page.unroute(route)
      await c.page.evaluate(() => {
        const s = (window as Window & { holdTestSocket?: WebSocket }).holdTestSocket
        s?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: '_ws:reconnected', data: {} }) }))
      })
      return { done: async () => (await present(c, id)()) && (await present(c, fresh)()), cleanup: () => ack(c, id) }
    },
  },
]

/**
 * Everything a Threads list draws that can stand above a card, and the change of CHANGES that moves
 * it there. tests/web/threads-hold.test.ts reads these two tables in this file: a new element kind drawn by
 * OrgThreadsByState or OrgThreadsWatching, or a new group, fails it until it has a row here, and
 * its row names a change below (a new kind of change is a new entry of CHANGES: a new column).
 */
export const ABOVE_A_CARD: Record<string, string> = {
  'org-thread': 'new card in his group',
  'org-thread-head': 'a card above grows',
  'org-thread-list': 'new card in a group above',
  'org-thread-group': 'new card in a group above',
  'org-thread-group-head': 'a folded group above gets its first card',
  'org-thread-group-count': 'a folded group above gets its first card',
  'org-thread-move-note': 'a card above leaves',
  'org-thread-move-show': 'its move line fades',
  'org-thread-groups': 'the list is read again after a reconnect',
  'org-threads-empty-row': 'none: drawn only when there is no card',
  'org-threads-empty': 'none: drawn only when there is no card',
}
/** Every group, and the change that brings one above a card (a fold's head shows the same for each). */
export const GROUPS_ABOVE: Record<string, string> = {
  watching: 'a card is watched (Watching, above all)',
  needs: 'new card in a group above',
  read: 'new card in his group',
  working: 'a folded group above gets its first card',
  waiting: 'a folded group above gets its first card',
  known: 'a folded group above gets its first card',
  done: 'a folded group above gets its first card',
  archived: 'a folded group above gets its first card',
}
