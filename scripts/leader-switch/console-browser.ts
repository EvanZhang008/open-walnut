/**
 * A person's browser on the old leader's machine after the switch (console-rehearsal.ts): it opens
 * http://localhost:<A's port>, the address A's leader served, now this machine's console replica
 * of B. Real clicks in Chromium (Playwright's library, one page for the whole run, recorded); the
 * first load is the address being opened, everything after it a click. Each write is then read
 * on B itself: it landed there, once.
 *
 * Screenshots and the recording go to `<out>/` (1280 x 800).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { Checks } from './rehearsal.js'
import type { ConsoleWorld } from './console-world.js'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface WalkData {
  board: { id: string; title: string }
  rename: { id: string; title: string }
  session: { id: string }
  note: { rel: string; name: string; text: string }
}

/** The data the walk opens, made on B (the leader) through its own API before the browser comes. */
export async function makeWalkData(cw: ConsoleWorld): Promise<WalkData> {
  const ok = <T>(r: { status: number; json: T }, what: string): T => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`)
    return r.json
  }
  const board = ok(await cw.api(cw.b, 'POST', '/api/tasks', { title: 'Release plan', project: 'Acme', description: 'Ship on Friday after the drill.' }), 'board task') as { task: { id: string } }
  ok(await cw.api(cw.b, 'PUT', `/api/v1/tasks/${board.task.id}/board`, { html: '<h1>Release</h1><p id="build">Build: green</p>' }), 'board')
  const rename = ok(await cw.api(cw.b, 'POST', '/api/tasks', { title: 'Rename me', project: 'Acme' }), 'task') as { task: { id: string } }
  const work = path.join(cw.b.dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  const started = ok(await cw.api(cw.b, 'POST', '/api/sessions/quick-start', { cwd: work, message: 'hello from the leader', taskId: board.task.id }), 'session') as { sessionId: string }
  const note = { rel: 'Acme/Release notes.md', name: 'Release notes', text: 'The rollback drill checklist for Friday.' }
  ok(await cw.api(cw.b, 'PUT', `/api/notes-v2/content/${encodeURI(note.rel)}`, { content: `# ${note.name}\n\n${note.text}\n` }), 'note')
  return { board: { id: board.task.id, title: 'Release plan' }, rename: { id: rename.task.id, title: 'Rename me' }, session: { id: started.sessionId }, note }
}

export class ConsoleBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  page!: Page
  readonly errors: string[] = []
  readonly failed: string[] = []

  constructor(private readonly cw: ConsoleWorld, private readonly out: string, private readonly data: WalkData) {}

  /** A task's row in the task list's search results (a home of thousands of tasks is searched, not scrolled). */
  private found(id: string, title?: string): Locator {
    const row = this.page.locator(`.todo-search-results .todo-panel-item[data-task-id="${id}"]`)
    return (title ? row.filter({ has: this.page.locator('.todo-item-title', { hasText: new RegExp(`^\\s*${escapeRe(title)}\\s*$`) }) }) : row).first()
  }

  /** Types into Home's "Search tasks" box, as a person does. */
  private async search(query: string): Promise<void> {
    const input = this.page.locator('#home-task-navigation .todo-search-input').first()
    await input.waitFor({ state: 'visible', timeout: 120_000 })
    await input.click()
    await input.fill(query)
  }

  private async clearSearch(): Promise<void> {
    const input = this.page.locator('#home-task-navigation .todo-search-input').first()
    if (await input.count()) await input.fill('')
  }

  private panel(): Locator {
    return this.page.locator(`.session-panel[data-session-id="${this.data.session.id}"]`).first()
  }

  async shot(name: string): Promise<string> {
    const file = path.join(this.out, `${name}.png`)
    await this.page.screenshot({ path: file })
    return file
  }

  /** Runs one step; a failure is a failed check with its message and a screenshot, and the walk goes on. */
  async step(c: Checks, name: string, fn: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = await fn()
      return c.add(`browser: ${name}`, true, detail ?? '')
    } catch (err) {
      const file = await this.shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '')
      this.failed.push(name)
      return c.add(`browser: ${name}`, false, `${err instanceof Error ? err.message.split('\n')[0] : String(err)}${file ? ` (${file})` : ''}`)
    }
  }

  async open(): Promise<void> {
    fs.mkdirSync(this.out, { recursive: true })
    this.browser = await chromium.launch({ headless: true })
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: path.join(this.out, 'video'), size: { width: 1280, height: 800 } } })
    this.page = await this.context.newPage()
    this.page.on('pageerror', (e) => this.errors.push(e.message))
    await this.page.goto(`http://localhost:${this.cw.a.port}/`)
  }

  private async navTo(name: string): Promise<void> {
    await this.page.locator('#primary-sidebar').getByRole('link', { name, exact: true }).first().click()
  }

  private async backToTasks(): Promise<void> {
    const exit = this.page.getByRole('button', { name: 'Exit full screen' })
    for (let i = 0; i < 3 && (await exit.count()) > 0; i++) { await exit.first().click(); await this.page.waitForTimeout(300) }
    if (!(await this.page.locator('.todo-panel').isVisible())) await this.navTo('Home')
    await this.page.locator('.todo-panel').waitFor({ state: 'visible', timeout: 30_000 })
  }

  /** Home, a task, its session's chat (and a message sent), its Board, a rename, a note (and an edit), Settings. */
  async walkOnline(c: Checks): Promise<{ sent: string; renamed: string; added: string }> {
    const p = this.page
    const sent = `Sent from the old leader's console ${randomBytes(3).toString('hex')}`
    const renamed = `Renamed at the console ${randomBytes(3).toString('hex')}`
    const added = ` Edited at the console ${randomBytes(3).toString('hex')}.`
    await this.step(c, 'Home opens at the old address (the task list of the new leader)', async () => {
      await p.locator('.todo-panel').waitFor({ state: 'visible', timeout: 120_000 })
      await this.shot('01-home')
      await this.search(this.data.board.title)
      await this.found(this.data.board.id).waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('01b-home-search')
    })
    await this.step(c, 'a task opens with its session\'s chat', async () => {
      await this.found(this.data.board.id).locator('.todo-item-title').first().click()
      await this.panel().waitFor({ state: 'visible', timeout: 30_000 })
      await this.panel().getByText('echo: hello from the leader').first().waitFor({ state: 'visible', timeout: 60_000 })
      await this.shot('02-task-session')
    })
    await this.step(c, 'a message sent to the session is answered', async () => {
      const composer = this.panel().locator('.session-panel-input textarea').first()
      await composer.click()
      await composer.fill(sent)
      await composer.press('Enter')
      await this.panel().locator('.session-msg-user').filter({ hasText: sent }).first().waitFor({ state: 'visible', timeout: 30_000 })
      await this.panel().getByText(`echo: ${sent}`).first().waitFor({ state: 'visible', timeout: 90_000 })
      await this.shot('03-message-sent')
    })
    await this.step(c, 'the task\'s Board opens', async () => {
      await this.panel().getByTestId('session-board-chip').click()
      const pane = p.getByTestId('task-board-pane')
      await pane.waitFor({ state: 'visible', timeout: 30_000 })
      const custom = pane.getByTestId('board-view-custom')
      await custom.waitFor({ state: 'visible', timeout: 15_000 })
      if ((await custom.getAttribute('aria-checked')) !== 'true') await custom.click()
      await p.frameLocator('.task-board-frame').locator('#build').filter({ hasText: 'Build: green' }).waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('04-board')
    })
    await this.backToTasks()
    await this.step(c, 'a task is renamed', async () => {
      await this.search(this.data.rename.title)
      const title = this.found(this.data.rename.id, this.data.rename.title).locator('.todo-item-title')
      await title.waitFor({ state: 'visible', timeout: 30_000 })
      await title.click()
      await title.click()
      const editing = p.locator('.todo-item-title.editing')
      await editing.waitFor({ state: 'visible', timeout: 10_000 })
      await editing.fill(renamed)
      await editing.press('Enter')
      await this.search(renamed)
      await this.found(this.data.rename.id, renamed).waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('05-renamed')
      await this.clearSearch()
    })
    await this.step(c, 'a note opens and an edit is saved', async () => {
      await this.navTo('Notes')
      const folder = p.locator('.notes-tree-folder[data-node-path="Acme"]').first()
      await folder.waitFor({ state: 'visible', timeout: 30_000 })
      if (!((await folder.locator('.notes-tree-arrow').getAttribute('class')) ?? '').includes('expanded')) await folder.click()
      await p.locator('.notes-tree-file', { hasText: this.data.note.name }).first().click()
      const editor = p.locator('.notes-editor-pane, .notes-editor').locator('.ProseMirror, .tiptap').first()
      const para = editor.locator('p', { hasText: this.data.note.text }).first()
      await para.waitFor({ state: 'visible', timeout: 30_000 })
      const box = (await para.boundingBox())!
      const saved = p.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/notes-v2/content/') && (r.request().postData() ?? '').includes(added.trim()), { timeout: 60_000 })
      await para.click({ position: { x: box.width - 2, y: box.height / 2 } })
      await p.keyboard.type(added, { delay: 15 })
      const res = await saved
      if (res.status() !== 200) throw new Error(`the note save answered ${res.status()}`)
      await this.shot('06-note-edited')
    })
    await this.step(c, 'Settings opens', async () => {
      await this.navTo('Settings')
      await p.locator('.settings-page, [data-testid="settings-page"], .settings-layout').first().waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('07-settings')
    })
    await this.step(c, 'Home again', async () => {
      await this.navTo('Home')
      await p.locator('.todo-panel').waitFor({ state: 'visible', timeout: 30_000 })
    })
    return { sent, renamed, added }
  }

  /** On B itself: each write of the walk is there, once. */
  async checkOnLeader(c: Checks, w: { sent: string; renamed: string; added: string }): Promise<void> {
    const task = await this.cw.api(this.cw.b, 'GET', `/api/tasks/${this.data.rename.id}`)
    const title = task.json?.task?.title ?? task.json?.title
    const all = await this.cw.api(this.cw.b, 'GET', '/api/tasks?project=Acme')
    const named = ((all.json?.tasks ?? []) as Array<{ title: string }>).filter((t) => t.title === w.renamed).length
    c.add('on B: the rename is there, on the one task', title === w.renamed && named === 1, `title ${JSON.stringify(title)}; ${named} task(s) with it`)
    const note = await this.cw.api(this.cw.b, 'GET', `/api/notes-v2/content/${encodeURI(this.data.note.rel)}`)
    const text = String(note.json?.content ?? '')
    const times = text.split(w.added.trim()).length - 1
    c.add('on B: the note edit is there, once', times === 1, `${times} time(s)`)
    const hist = await this.cw.api(this.cw.b, 'GET', `/api/sessions/${this.data.session.id}/history`)
    const body = JSON.stringify(hist.json ?? {})
    const sentTimes = body.split(w.sent).length - 1
    const answers = body.split(`echo: ${w.sent}`).length - 1
    c.add('on B: the message reached the session once and was answered once', hist.status === 200 && answers === 1 && sentTimes === 2, `history ${hist.status}: the words ${sentTimes} time(s) (the message and its echo), the answer ${answers}`)
  }

  /** While B is cut off: the line saying so, reads from the copies, a kept write, a refused one. */
  async walkAway(c: Checks): Promise<{ keptTitle: string | null }> {
    const p = this.page
    let keptTitle: string | null = null
    await this.step(c, 'away: the line says the leader is away, and since when', async () => {
      const line = p.getByTestId('away-line')
      await line.waitFor({ state: 'visible', timeout: 60_000 })
      const text = (await line.textContent()) ?? ''
      await this.shot('08-away-line')
      if (/Your Mac is away/.test(text)) throw new Error(`it says "${text.trim()}": on this console the Mac is right here`)
      return text.trim()
    })
    await this.step(c, 'away: the task list and a note read from this machine\'s copies', async () => {
      await this.navTo('Home')
      await this.search(this.data.board.title)
      await this.found(this.data.board.id).waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('09a-away-task-search')
      await this.clearSearch()
      await this.navTo('Notes')
      await p.locator('.notes-tree-file', { hasText: this.data.note.name }).first().click()
      await p.locator('.notes-editor-pane, .notes-editor').locator('.ProseMirror, .tiptap').first().filter({ hasText: this.data.note.text }).waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('09-away-reads')
    })
    await this.step(c, 'away: a new task is kept on this machine and marked as not yet synced', async () => {
      await this.navTo('Home')
      keptTitle = `Made while the leader was away ${randomBytes(3).toString('hex')}`
      const made = await p.evaluate(async (title) => {
        // The console's own create (its device token, as every console request): the add box's request.
        const r = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, project: 'Acme' }) })
        return { status: r.status, body: await r.text() }
      }, keptTitle)
      if (made.status >= 300) throw new Error(`the create answered ${made.status} ${made.body.slice(0, 200)}`)
      const id = (JSON.parse(made.body) as { task?: { id?: string } }).task?.id
      if (!id) throw new Error(`the create answered no task id: ${made.body.slice(0, 200)}`)
      await this.search(keptTitle!)
      await this.found(id).getByTestId('away-sync-mark').waitFor({ state: 'visible', timeout: 30_000 })
      await this.shot('10-away-kept-write')
      await this.clearSearch()
      return `${made.status}`
    })
    await this.step(c, 'away: a write that needs the leader is refused with a line saying so', async () => {
      const r = await p.evaluate(async () => {
        const res = await fetch('/api/cron', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'refused away', schedule: { kind: 'every', everyMs: 86_400_000 }, sessionTarget: 'main', payload: { kind: 'systemEvent', text: 'x' } }) })
        return { status: res.status, body: await res.text() }
      })
      if (r.status < 400) throw new Error(`it answered ${r.status}: nothing should look saved`)
      return `${r.status} ${r.body.slice(0, 160)}`
    })
    return { keptTitle }
  }

  /** After B is back: the away line is gone, and the kept write reached B once. */
  async afterBack(c: Checks, keptTitle: string | null): Promise<void> {
    await this.step(c, 'back: the away line goes by itself', async () => {
      await this.page.getByTestId('away-line').waitFor({ state: 'detached', timeout: 120_000 })
      await this.shot('11-back')
    })
    if (!keptTitle) return
    let count = -1
    for (let i = 0; i < 90 && count !== 1; i++) {
      const all = await this.cw.api(this.cw.b, 'GET', '/api/tasks?project=Acme').catch(() => null)
      count = ((all?.json?.tasks ?? []) as Array<{ title: string }>).filter((t) => t.title === keptTitle).length
      if (count !== 1) await new Promise((r) => setTimeout(r, 2_000))
    }
    c.add('back: the task made while B was away is on B, once (the journal replayed once)', count === 1, `${count} on B`)
  }

  /** Closes the page and writes the recording as an MP4; returns its path (or null). */
  async close(): Promise<string | null> {
    const video = this.page?.video()
    await this.context?.close()
    await this.browser?.close()
    const webm = video ? await video.path().catch(() => null) : null
    if (!webm || !fs.existsSync(webm)) return null
    const mp4 = path.join(this.out, 'console-walk.mp4')
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
      return mp4
    } catch {
      return webm
    }
  }
}
