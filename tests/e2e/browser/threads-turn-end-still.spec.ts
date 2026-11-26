/**
 * A lead's turn end leaves his Threads still (2026-11-23, the user: "每次它结束聊天之后，我会看到屏幕
 * 闪一下，会显示好多好多不同的 thread 或者 task ... 然后最后又消失"). His VP's status answer rewrote
 * all 12 threads it was asked about, every turn, with new words and the same state.
 *
 * A lead with a dozen threads (Done, Working, Waiting) and one question of his it has not answered,
 * on its Org page, every experiment on as he runs it. Its session answers the status question as a
 * node does (the fixture CLI's `reword-threads`): a line in new words for every thread the question
 * quotes no card for. He sends a chat message; the turn ends and its status answer comes. His
 * unanswered question gets its line, the hidden ones theirs; the cards in Done keep their words and
 * their order, and nothing in his Threads appears only to vanish a moment later.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'
import { setServerFlags, type RestoreServerFlags } from './server-flags'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Orchard ${STAMP}`
const made: string[] = []
const ids = { lead: '', sid: '', asked: '' }
let restoreFlags: RestoreServerFlags | null = null

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)
test.use({ viewport: { width: 1280, height: 900 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

/** Every element of his Threads that leaves within 4 s of coming, with its words (only ones with words). */
const PROBE = `(() => {
  window.__flash = []; window.__probeOn = false;
  const born = new WeakMap();
  const mo = new MutationObserver((recs) => {
    const now = performance.now();
    for (const r of recs) {
      r.addedNodes.forEach((n) => { if (n.nodeType === 1) born.set(n, now) });
      // Only his Threads beside the chat: the chat's own rows (his message on its way, "Waiting for
      // response") come and go by design.
      if (!(r.target instanceof Element) || !r.target.closest('[data-testid="org-rail"]')) continue;
      r.removedNodes.forEach((n) => {
        if (n.nodeType !== 1 || !window.__probeOn) return;
        const b = born.get(n);
        if (b === undefined || now - b > 4000) return;
        const text = (n.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length < 8) return;
        window.__flash.push({ lived: Math.round(now - b), testid: n.getAttribute('data-testid'), cls: String(n.className || '').slice(0, 60), text: text.slice(0, 100) });
      });
    }
  });
  const start = () => mo.observe(document.body, { childList: true, subtree: true });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})()`

const cardOrder = (page: Page) => page.getByTestId('org-detail').locator('[data-testid="org-thread"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')))
const cardWords = (page: Page) => page.getByTestId('org-detail').locator('[data-testid="org-thread-reply"]').allTextContents()

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  // Put back exactly as it was (server-flags.ts): the "put back" of a top-level read of the config,
  // always {}, left every_experiment on for the specs after this one (quiet_rail took Routines off the rail).
  // quiet_rail stays off while this spec runs: a flag set alone wins over every_experiment, and specs
  // in other workers look for their rail links meanwhile.
  restoreFlags = await setServerFlags(request, { every_experiment: true, quiet_rail: false })
  for (const title of [`Prune the apple trees ${STAMP}`, `Net the cherries ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started. reword-threads', taskId: ids.lead })
  await expect.poll(async () => (ids.sid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // A dozen subjects: results to read (Done), work in hand (Working), work a team has (Waiting).
  const states = ['answered', 'answered', 'answered', 'answered', 'working', 'working', 'working', 'working', 'pending', 'pending', 'pending', 'working'] as const
  for (const [i, state] of states.entries()) {
    const { thread } = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title: `Orchard row ${i + 1} ${STAMP}`, text: `Row ${i + 1}: the trees are pruned and the ties hold.`, from: 'node', state: 'answered' }, ids.sid)
    // A result to read carries its summary, as one does after the node's first line on it.
    const patch = state === 'answered' ? { reply: `Row ${i + 1}: pruned, and the ties hold until spring.` } : { state }
    await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${thread.id}`, patch, ids.sid)
  }
  // And one question of his the lead has not answered yet: its card has no words, so it gets a line.
  ids.asked = (await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads`, { text: `Which rootstock for the new pear trees ${STAMP}?` })).thread.id
})

test.afterAll(async ({ request }) => {
  await restoreFlags?.(request)
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

test('a lead\'s turn end: nothing in his Threads comes and goes, the cards keep their words and order', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await page.addInitScript(PROBE)
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.locator('[data-testid="org-thread"]').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(3000)
  const before = await cardOrder(page)
  const wordsBefore = await cardWords(page)
  await video.caption('A lead with a dozen threads: results to read, work in hand, work a team has')
  await video.hold(1500)

  // He sends a chat message; the turn ends and its status answer comes: a line only for the thread
  // whose card has no words yet (the fixture CLI answers as a node following the question does).
  await page.evaluate(() => { (window as unknown as { __probeOn: boolean }).__probeOn = true })
  const composer = detail.locator('.chat-input-textarea').first()
  await composer.click()
  await page.keyboard.type('snapshot-clean-turn:Noted, thanks. reword-threads')
  await page.keyboard.press('Enter')
  await video.caption('He sends a chat message: the turn ends and its status answer comes')
  await expect.poll(async () => {
    const file = (await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json()) as { threads: Array<{ id: string; reply?: string }> }
    return file.threads.find((t) => t.id === ids.asked)?.reply ?? ''
  }, { timeout: 120_000 }).toMatch(/check \d+ says/)
  await page.waitForTimeout(8000)
  const flashes = await page.evaluate(() => (window as unknown as { __flash: unknown[] }).__flash)
  const after = await cardOrder(page)
  const wordsAfter = await cardWords(page)
  await video.caption('After the status answer')
  await video.hold(1500)
  await video.stop('threads-turn-end-still')
  console.log('FLASHES', JSON.stringify(flashes, null, 1))
  console.log('ORDER', JSON.stringify({ before, after }))
  expect(flashes).toEqual([])
  expect(after).toEqual(before)
  expect(wordsAfter).toEqual(wordsBefore)
  expect(pageErrors).toEqual([])
})
