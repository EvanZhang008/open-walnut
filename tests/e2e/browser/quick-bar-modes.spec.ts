/**
 * The quick bar's modes and keys beyond the send (web/src/components/quickbar/quickbar-modes.ts,
 * QuickBarResults.tsx, QuickBarAsk.tsx), in Chromium:
 *   - "task <words>" + Tab searches tasks, the arrows walk the list and Enter opens one; "note" the
 *     same for notes; "?" asks a quick question answered in the bar, asked again to go on, and made
 *     a task with one click; a message that only starts like a keyword still sends on Enter;
 *   - Cmd-K opens the bar for typing, and on the Notes page in its notes search; off, it does not;
 *   - the people list not loading (Walnut restarting): the chip and the send name one person, the
 *     last one sent to or the CEO, the bar says it is retrying, and Retry now loads the list.
 * Voice is off (the bar opens for typing); the searches, the answer and the people list are stubbed,
 * and the switch is pinned in the page (pinFlag), never written to the server's config, which every
 * spec file in a parallel worker shares.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { bar, chip, openApp, PEOPLE, pinFlag, shot, stubAll, voiceOff } from './quick-bar-helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

const TASKS = [
  { id: 'pw-task-tile', title: 'Pick the tile color', project: 'Garden', state: 'needs', stateLabel: 'Needs you' },
  { id: 'pw-task-beds', title: 'Plan the tile beds', project: 'Garden', state: 'waiting', stateLabel: 'Waiting' },
]
const NOTES = [
  { path: 'Garden/Spring beds.md', title: 'Spring beds', snippet: 'Sand tiles along the path' },
  { path: 'Garden/Tile samples.md', title: 'Tile samples', snippet: 'Blue, sand, slate' },
]

interface Searches { tasks: string[]; notes: string[]; asks: Array<{ text: string; conversation?: string }>; sessions: string[] }

async function stubSearches(page: Page): Promise<Searches> {
  const seen: Searches = { tasks: [], notes: [], asks: [], sessions: [] }
  await page.route('**/api/v1/quick/tasks**', (r) => {
    const url = new URL(r.request().url())
    seen.tasks.push(url.search)
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const rows = url.searchParams.get('recent') === '1' ? TASKS : TASKS.filter((t) => t.title.toLowerCase().includes(q))
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: rows }) })
  })
  await page.route('**/api/notes-v2/search**', (r) => {
    const url = new URL(r.request().url())
    seen.notes.push(url.search)
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: NOTES.filter((n) => `${n.title} ${n.snippet}`.toLowerCase().includes(q)) }) })
  })
  await page.route('**/api/v1/quick/ask', (r) => {
    const body = JSON.parse(r.request().postData() ?? '{}')
    seen.asks.push(body)
    const answer = seen.asks.length === 1 ? 'About three hours each way.' : 'Back is the same, a little more with traffic.'
    // As the server does: the conversation key is the asker's, echoed back (src/core/ai/ai-run.ts).
    const lines = [{ type: 'text', delta: answer.slice(0, 6) }, { type: 'result', text: answer, ...(body.conversation ? { conversation: body.conversation } : {}) }]
    return r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
  })
  await page.route('**/api/v1/quick/session', (r) => {
    seen.sessions.push(JSON.parse(r.request().postData() ?? '{}').text)
    return r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'sent', taskId: 'pw-ask-task', sessionId: 's-2', started: true })}\n` })
  })
  return seen
}

/**
 * The task paths the page went to. A task's path opens it on Home and puts Home's URL back
 * (App.tsx, open-session.ts openTaskHere), so its URL shows only for a moment: what the bar did is
 * the one step it took to the task's path.
 */
async function tasksOpened(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __qbOpened: string[] }
    w.__qbOpened = []
    const push = history.pushState.bind(history)
    history.pushState = (data, unused, url) => {
      const to = String(url ?? '')
      if (to.startsWith('/tasks/')) w.__qbOpened.push(to)
      return push(data, unused, url)
    }
  })
  return () => page.evaluate(() => (window as unknown as { __qbOpened: string[] }).__qbOpened)
}

const results = (page: Page) => page.locator('.qb-result')
/** The bar's one text box, named for what it does in each mode ("Message", "Search tasks", ...). */
const box = (page: Page) => page.locator('.qb-center textarea.qb-text')

test('task + Tab searches tasks; the arrows choose, Enter opens it; Backspace on nothing goes back', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  const seen = await stubSearches(page)
  const opened = await tasksOpened(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(box(page)).toBeFocused()
  // The empty box shows what else the bar does.
  await expect(page.locator('.qb-mode-pill')).toHaveCount(3)
  await shot(page, 'm0-pills')

  await box(page).pressSequentially('task tile')
  await expect(page.locator('.qb-foot')).toContainText('Search tasks for “tile”')
  await box(page).press('Tab')
  await expect(bar(page)).toHaveAttribute('data-mode', 'tasks')
  await expect(page.locator('.qb-mode-chip')).toContainText('Tasks')
  await expect(box(page)).toHaveValue('tile')
  await expect(box(page)).toHaveAttribute('aria-label', 'Search tasks')
  await expect(page.locator('.qb-picker')).toHaveCount(0)
  await expect(results(page).locator('.qb-result-title')).toHaveText(['Pick the tile color', 'Plan the tile beds'])
  await expect(results(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.qb-keys')).toHaveText(/choose.*open.*back/)
  await shot(page, 'm1-tasks')

  // Backspace with words left only edits; on an empty query it goes back to the message.
  await box(page).fill('')
  // No words: the open tasks.
  await expect.poll(() => seen.tasks.at(-1)).toContain('recent=1')
  await expect(results(page)).toHaveCount(2)
  await box(page).press('Backspace')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(chip(page)).toHaveText('CEO')

  await box(page).pressSequentially('tasks tile')
  await box(page).press('Tab')
  await expect(results(page)).toHaveCount(2)
  await box(page).press('ArrowDown')
  await expect(results(page).nth(1)).toHaveAttribute('aria-selected', 'true')
  await box(page).press('Enter')
  await expect(bar(page)).toBeHidden()
  await expect.poll(opened).toEqual(['/tasks/pw-task-beds'])
  expect(sends.bodies).toHaveLength(0)

  // The next open is the message again.
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(box(page)).toHaveValue('')
})

test('Tab lists what the bar does: the arrows pick Search notes, its words search, Enter opens the note', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  const seen = await stubSearches(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(box(page)).toHaveAttribute('placeholder', 'Type a message, or Tab to see what you can do')
  await box(page).press('Tab')
  const rows = page.locator('.qb-mode-row')
  await expect(rows.locator('.qb-mode-row-name')).toHaveText(['Search tasks', 'Search notes', 'Ask a quick question'])
  await expect(rows.locator('.qb-mode-row-about')).toHaveText([
    'Find a task by its words and open its chat', 'Find a note by its title or text and open it', 'An answer right here, with no task made',
  ])
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  // The modes are listed once: the footer's own mode pills step aside while the list is open.
  await expect(page.locator('.qb-mode-pill')).toHaveCount(0)
  await shot(page, 'm5-tab-list')
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await expect(page.locator('.qb-picker')).toHaveCount(0)
  await expect(box(page)).toBeFocused()
  await box(page).pressSequentially('sand')
  await expect(results(page).locator('.qb-result-title')).toHaveText(['Spring beds', 'Tile samples'])
  expect(seen.notes.at(-1)).toContain('q=sand')
  await box(page).press('Enter')
  await expect(bar(page)).toBeHidden()
  await expect(page).toHaveURL(/\/notes\?path=Garden%2FSpring(%20|\+)beds\.md$/)

  // Words typed first become the search; the list's own box narrows it ("no" keeps Search notes).
  await page.getByTestId('sidebar-quick-bar').click()
  await box(page).pressSequentially('tile')
  await box(page).press('Tab')
  await page.keyboard.type('no')
  await expect(rows.locator('.qb-mode-row-name')).toHaveText(['Search notes'])
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await expect(box(page)).toHaveValue('tile')
  await expect.poll(() => seen.notes.at(-1)).toContain('q=tile')
  await expect(results(page).locator('.qb-result-title')).toHaveText(['Spring beds', 'Tile samples'])
  // Esc goes back to the message as it was.
  await box(page).press('Escape')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(box(page)).toHaveValue('tile')
  // A click on a row does the same as Enter.
  await box(page).press('Tab')
  await rows.filter({ hasText: 'Ask a quick question' }).click()
  await expect(bar(page)).toHaveAttribute('data-mode', 'ask')
  expect(sends.bodies).toHaveLength(0)
})

test('a message that only starts like a keyword still sends on Enter', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await stubSearches(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await box(page).pressSequentially('ask the VP to ship it')
  // Tab by mistake switches to Ask; Esc goes back with the message whole.
  await box(page).press('Tab')
  await expect(bar(page)).toHaveAttribute('data-mode', 'ask')
  await expect(box(page)).toHaveValue('the VP to ship it')
  await box(page).press('Escape')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(box(page)).toHaveValue('ask the VP to ship it')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length).toBe(1)
  expect(sends.bodies[0]).toMatchObject({ text: 'ask the VP to ship it' })
})

test('the Notes pill searches notes and Enter opens the note; Cmd-K on the Notes page opens on notes', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  const seen = await stubSearches(page)
  await openApp(page)
  // Cmd-K opens the bar for typing, never listening; again closes it.
  await page.keyboard.press('Meta+k')
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toHaveAttribute('data-recording', 'false')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await page.keyboard.press('Meta+k')
  await expect(bar(page)).toBeHidden()

  await page.getByTestId('sidebar-quick-bar').click()
  await page.locator('.qb-mode-pill.qb-mode-notes').click()
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await expect(box(page)).toBeFocused()
  await expect(page.locator('.qb-results-empty')).toHaveText('Type words from a note’s title or text.')
  await box(page).pressSequentially('sand')
  await expect(results(page).locator('.qb-result-title')).toHaveText(['Spring beds', 'Tile samples'])
  expect(seen.notes.at(-1)).toContain('mode=string')
  await shot(page, 'm2-notes')
  await results(page).nth(1).click()
  await expect(bar(page)).toBeHidden()
  await expect(page).toHaveURL(/\/notes\?path=Garden%2FTile(%20|\+)samples\.md$/)

  // On the Notes page Cmd-K is the bar's notes search (it replaced the page's own palette).
  await page.keyboard.press('Meta+k')
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await expect(page.locator('.qb-mode-chip')).toContainText('Notes')
  await expect(page.locator('.notes-cmdk')).toHaveCount(0)
  // Esc in a mode goes back to the message; again closes.
  await box(page).press('Escape')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await box(page).press('Escape')
  await expect(bar(page)).toBeHidden()
  // Again, typing at once: the words go into the bar, never into the page under it (a "?" there
  // opened the shortcuts list while the bar was still coming up).
  await page.keyboard.press('Meta+k')
  await page.keyboard.type('?x')
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await expect(box(page)).toHaveValue('?x')
  await expect(page.locator('.app-modal-title', { hasText: 'Keyboard shortcuts' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(bar(page)).toBeHidden()
  // The page's "+" tab still opens its own palette (a new note), not the bar.
  await page.getByRole('button', { name: 'New tab' }).click()
  await expect(page.locator('.notes-cmdk').first()).toBeVisible()
  await expect(bar(page)).toBeHidden()
})

test('? asks a quick question: the answer shows in the bar, asking again goes on, one click makes it a task', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  const seen = await stubSearches(page)
  const opened = await tasksOpened(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await box(page).pressSequentially('?how long is the drive to the coast')
  await box(page).press('Tab')
  await expect(bar(page)).toHaveAttribute('data-mode', 'ask')
  await expect(box(page)).toHaveValue('how long is the drive to the coast')
  await box(page).press('Enter')
  const turns = page.locator('.qb-ask-turn')
  await expect(turns.locator('.qb-ask-a')).toHaveText(['About three hours each way.'])
  await expect(box(page)).toHaveValue('')
  expect(seen.asks[0]).toMatchObject({ text: 'how long is the drive to the coast', conversation: expect.stringMatching(/^quickbar-/) })
  await box(page).pressSequentially('and back?')
  await box(page).press('Enter')
  await expect(turns.locator('.qb-ask-q')).toHaveText(['how long is the drive to the coast', 'and back?'])
  await expect(turns.nth(1).locator('.qb-ask-a')).toHaveText('Back is the same, a little more with traffic.')
  // The follow-up goes on with the same conversation.
  expect(seen.asks[1]).toEqual({ text: 'and back?', conversation: seen.asks[0].conversation })
  await shot(page, 'm3-ask')
  await page.getByTestId('qb-ask-task').click()
  await expect.poll(() => seen.sessions.length).toBe(1)
  await expect.poll(opened).toEqual(['/tasks/pw-ask-task'])
  await expect(bar(page)).toBeHidden()
  expect(seen.sessions[0]).toContain('Q: how long is the drive to the coast')
  expect(seen.sessions[0]).toContain('A: Back is the same')
  expect(sends.bodies).toHaveLength(0)
})

test('off, Cmd-K does not open the bar', async ({ page }) => {
  await pinFlag(page, false)
  await stubAll(page)
  await openApp(page, false)
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(400)
  await expect(page.locator('.qb-bar')).toHaveCount(0)
})

/** The people list never answers, as while Walnut restarts. */
async function peopleDown(page: Page): Promise<{ up: () => void; asked: () => number }> {
  let down = true
  let asked = 0
  await page.route('**/api/v1/quick/people**', (r) => {
    asked++
    if (down) return r.abort('connectionrefused')
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ people: PEOPLE }) })
  })
  return { up: () => { down = false }, asked: () => asked }
}

test('the people list not loading: the chip says who gets the words, and that is who gets them', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  // Sent to the Walnut VP a minute ago, so the bar opens on the VP.
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut:quickbar-recents', JSON.stringify([{ id: 'pw-vp-walnut', title: 'Walnut VP', kind: 'vp', at: Date.now() - 60_000 }])) } catch { /* about:blank */ }
  })
  const people = await peopleDown(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(page.locator('.qb-foot')).toContainText('Walnut is restarting, trying again in a few seconds. Sends go to Walnut VP.', { timeout: 10_000 })
  await expect(chip(page)).toHaveText('Walnut VP')
  await shot(page, 'm4-people-down')
  // It tries again by itself.
  const before = people.asked()
  await expect.poll(() => people.asked(), { timeout: 10_000 }).toBeGreaterThan(before)
  await box(page).fill('Ship it today')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length).toBe(1)
  expect(sends.bodies[0]).toMatchObject({ to: 'pw-vp-walnut', text: 'Ship it today' })

  // Opened again while still down: the same note. Walnut back, Retry now loads the list at once.
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(chip(page)).toHaveText('Walnut VP')
  const retry = page.getByRole('button', { name: 'Retry now' })
  await expect(retry).toBeVisible({ timeout: 10_000 })
  people.up()
  await retry.click()
  await expect(page.locator('.qb-foot')).not.toContainText('restarting', { timeout: 5_000 })
  await expect(chip(page)).toHaveText('Walnut VP')
  await box(page).press('Tab')
  await expect(page.locator('.qb-person-name')).toHaveText(['CEO', 'Walnut VP', 'Garden VP', 'Pick the tile color'])
})

test('the people list not loading and nobody sent to lately: the chip says CEO and the words go to the CEO', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await peopleDown(page)
  await openApp(page)
  await page.getByTestId('sidebar-quick-bar').click()
  await expect(page.locator('.qb-foot')).toContainText('Sends go to CEO.', { timeout: 10_000 })
  await expect(chip(page)).toHaveText('CEO')
  await box(page).fill('What is on today')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length).toBe(1)
  expect(sends.bodies[0]).toEqual({ text: 'What is on today', follow: true })
})
