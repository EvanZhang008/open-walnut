/**
 * A page in the Files preview keeps its storage as a browser keeps a site's.
 *
 * 2026-11-18, the user: "how about regular browser storage like cache etc, these should be same as
 * well right". The page runs in an opaque origin (it must never read Walnut's sign-in), where every
 * storage API throws; src/web/preview-state-script.ts gives it each one, kept on disk per file
 * (localStorage, persistent cookies, IndexedDB, the Cache API) or with this Walnut window
 * (sessionStorage, session cookies), as a browser keeps them for a site and for a tab.
 *
 * Pinned here, through real UI clicks and the agent's tool event:
 *  - every storage API works and keeps what the page wrote across the agent writing the file again,
 *    the file opened again, Walnut reloaded, and the app restarted (a new browser with the same
 *    server): after the restart the site's storage is back and the tab's is gone, as in a browser;
 *  - localStorage and sessionStorage are separate stores;
 *  - the page reads nothing of Walnut's (its storage, its cookies), Walnut's storage holds nothing of
 *    the page's, and another file's page gets none of it;
 *  - the guard: every storage API the page sees in this engine is listed in
 *    src/web/preview-storage-apis.ts, so a new one gets a decision.
 */
import { test, expect, type Browser, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { goToSessionFolder } from './todo-panel-helpers'
import { STORAGE_APIS, STORAGE_API_PATTERN } from '../../../src/web/preview-storage-apis'

test.use({ viewport: { width: 1280, height: 860 } })

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

type EventWindow = Window & { fileTestSocket?: WebSocket }

async function openApp(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as EventWindow).fileTestSocket = this
      }
    }
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
      Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key] })
    }
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
}

async function emitEvent(page: Page, name: string, data: Record<string, unknown>) {
  await page.waitForFunction(() => (window as EventWindow).fileTestSocket?.readyState === 1, null, { timeout: 30_000 })
  await page.evaluate(({ name, data }) => {
    const socket = (window as EventWindow).fileTestSocket
    if (!socket) throw new Error('Missing fixture socket')
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data }) }))
  }, { name, data })
}

async function agentWrites(page: Page, abs: string, content: string) {
  await writeFile(abs, content)
  const data = { sessionId: SESSION_ID, toolUseId: `storage-test-${Date.now()}`, toolName: 'Write', input: { file_path: abs } }
  await emitEvent(page, 'session:tool-use', data)
  await emitEvent(page, 'session:tool-result', data)
}

/** A page that shows, on load, what each storage API holds. */
function pageHtml(version: number): string {
  return `<!doctype html><html><head><title>Storage fixture</title></head><body>
<h1 id="title">Storage fixture version ${version}</h1>
<p>local <span id="ls">?</span> session <span id="ss">?</span> cookies <span id="ck">?</span></p>
<p>idb <span id="idb">?</span> cache <span id="cache">?</span> estimate <span id="est">?</span></p>
<script>
  function show(id, v){ document.getElementById(id).textContent = v; }
  try { show('ls', localStorage.getItem('k') || 'none'); } catch (e) { show('ls', 'threw ' + e.name); }
  try { show('ss', sessionStorage.getItem('k') || 'none'); } catch (e) { show('ss', 'threw ' + e.name); }
  try { show('ck', document.cookie || 'none'); } catch (e) { show('ck', 'threw ' + e.name); }
  try {
    var r = indexedDB.open('notes', 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore('items', { keyPath: 'id' }).createIndex('byTag', 'tag'); };
    r.onsuccess = function(){
      var db = r.result, g = db.transaction('items').objectStore('items').get(1);
      g.onsuccess = function(){
        var v = g.result;
        show('idb', v ? v.text + '|' + (v.when instanceof Date ? v.when.toISOString() : 'no-date') + '|' + (v.bytes instanceof Uint8Array ? Array.from(v.bytes).join(',') : 'no-bytes') + '|' + (v.tags instanceof Set ? [...v.tags].join(',') : 'no-set') : 'none');
        db.close();
      };
    };
    r.onerror = function(){ show('idb', 'error ' + r.error); };
  } catch (e) { show('idb', 'threw ' + e.name); }
  try {
    caches.open('v1').then(function(c){ return c.match('data.json'); }).then(function(res){ return res ? res.text() : 'none'; })
      .then(function(t){ show('cache', t); }, function(e){ show('cache', 'rejected ' + e.name); });
  } catch (e) { show('cache', 'threw ' + e.name); }
  try { navigator.storage.estimate().then(function(e){ show('est', e.quota > 0 ? 'ok' : 'zero'); }, function(e){ show('est', 'rejected ' + e.name); }); } catch (e) { show('est', 'threw ' + e.name); }
</script></body></html>
`
}

async function scratchHtml(page: Page, name: string, html: string): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  const body = await res.json()
  const abs = `${(body?.session?.cwd ?? body?.cwd) as string}/${name}`
  expect((await page.request.post('/api/files/create', { data: { path: abs } })).status()).toBe(200)
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: html } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

/** The session's Files tab; after a reload of Walnut its layout may bring both back by itself. */
async function openFiles(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  const explorer = panel.locator('.session-file-explorer')
  await page.waitForTimeout(1000)
  if (!(await panel.isVisible())) {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.locator('.todo-item-title').click()
    await expect(panel).toBeVisible()
  }
  if (!(await explorer.isVisible())) await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  await goToSessionFolder(explorer)
  return explorer
}

async function openFile(page: Page, explorer: Locator, name: string, title: string): Promise<FrameLocator> {
  await explorer.locator('.sfe-name', { hasText: name }).click()
  const frame = page.frameLocator('iframe.fv-html-preview')
  await expect(frame.locator('h1')).toContainText(title, { timeout: 15_000 })
  return frame
}

/** What the page shows once each read has answered. */
async function shown(frame: FrameLocator) {
  for (const id of ['#idb', '#cache', '#est']) await expect(frame.locator(id)).not.toHaveText('?', { timeout: 10_000 })
  const out: Record<string, string> = {}
  for (const id of ['ls', 'ss', 'ck', 'idb', 'cache', 'est']) out[id] = (await frame.locator(`#${id}`).textContent()) ?? ''
  return out
}

const WHEN = '2026-11-18T08:00:00.000Z'
const SITE = { ls: 'kept', idb: `hello|${WHEN}|1,2,3|a,b`, cache: '{"n":7}', est: 'ok' }

async function writeEverything(frame: FrameLocator) {
  await frame.locator('body').evaluate(async (_, when) => {
    localStorage.setItem('k', 'kept')
    sessionStorage.setItem('k', 'tab')
    document.cookie = 'pc=1; max-age=3600; path=/'
    document.cookie = 'sc=2; path=/'
    await new Promise<void>((ok, no) => {
      const r = indexedDB.open('notes', 1)
      r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }).createIndex('byTag', 'tag') }
      r.onsuccess = () => {
        const t = r.result.transaction('items', 'readwrite')
        t.objectStore('items').put({ id: 1, text: 'hello', when: new Date(when), bytes: new Uint8Array([1, 2, 3]), tags: new Set(['a', 'b']), tag: 'x' })
        t.oncomplete = () => { r.result.close(); ok() }
        t.onerror = () => no(t.error)
      }
      r.onerror = () => no(r.error)
    })
    const c = await caches.open('v1')
    await c.put('data.json', new Response('{"n":7}', { headers: { 'Content-Type': 'application/json' } }))
  }, WHEN)
  // The page's state is sent after its writes settle, and kept on disk a moment later.
  await frame.locator('body').evaluate(() => new Promise((r) => setTimeout(r, 1500)))
}

test.beforeEach(async ({ page, baseURL }) => { await openApp(page, baseURL!) })

test('every storage API keeps what the page wrote: rewrite, reopen, Walnut reload, app restart', async ({ page, browser, baseURL }) => {
  const name = `storage-${Date.now()}.html`
  const abs = await scratchHtml(page, name, pageHtml(1))
  let explorer = await openFiles(page)
  let frame = await openFile(page, explorer, name, 'version 1')
  // Before: nothing kept, and nothing throws.
  expect(await shown(frame)).toEqual({ ls: 'none', ss: 'none', ck: 'none', idb: 'none', cache: 'none', est: 'ok' })
  await writeEverything(frame)

  // The agent writes the file again: the page loads again with all of it.
  await agentWrites(page, abs, pageHtml(2))
  await expect(frame.locator('h1')).toContainText('version 2', { timeout: 15_000 })
  expect(await shown(frame)).toEqual({ ...SITE, ss: 'tab', ck: 'pc=1; sc=2' })

  // The file opened again (a new frame): still all of it, the tab's part from this Walnut window.
  await explorer.locator('.sfe-name', { hasText: 'drag-fixture.html' }).click()
  await expect(page.frameLocator('iframe.fv-html-preview').locator('body')).toContainText('Drag fixture preview', { timeout: 10_000 })
  frame = await openFile(page, explorer, name, 'version 2')
  expect(await shown(frame)).toEqual({ ...SITE, ss: 'tab', ck: 'pc=1; sc=2' })

  // Walnut reloaded: the site's part from disk, the tab's from this window's sessionStorage.
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
  explorer = await openFiles(page)
  frame = await openFile(page, explorer, name, 'version 2')
  expect(await shown(frame)).toEqual({ ...SITE, ss: 'tab', ck: 'pc=1; sc=2' })

  // The app restarted (a new browser, the same server): the site's storage is back, the tab's is
  // gone, as after closing a browser.
  const restarted = await (browser as Browser).newContext({ viewport: { width: 1280, height: 860 } })
  try {
    const p2 = await restarted.newPage()
    await openApp(p2, baseURL!)
    const ex2 = await openFiles(p2)
    const f2 = await openFile(p2, ex2, name, 'version 2')
    expect(await shown(f2)).toEqual({ ...SITE, ss: 'none', ck: 'pc=1' })
  } finally {
    await restarted.close()
  }
})

test('localStorage and sessionStorage are separate, and nothing crosses to Walnut or another file', async ({ page, context }) => {
  const a = `storage-a-${Date.now()}.html`
  const b = `storage-b-${Date.now()}.html`
  await scratchHtml(page, a, pageHtml(1))
  await scratchHtml(page, b, pageHtml(1))
  await page.evaluate(() => localStorage.setItem('walnut.vault.session', 'fake-unlock-token-for-the-test'))
  const explorer = await openFiles(page)
  const frame = await openFile(page, explorer, a, 'version 1')
  await shown(frame)
  const seen = await frame.locator('body').evaluate(() => {
    localStorage.setItem('only', 'local')
    sessionStorage.setItem('only', 'session')
    document.cookie = 'pagecookie=1; max-age=3600'
    const read = (f: () => unknown) => { try { return String(f()) } catch (e) { return `blocked:${(e as Error).name}` } }
    return {
      sessionSeesLocal: sessionStorage.getItem('k'),
      localOnly: localStorage.getItem('only'),
      sessionOnly: sessionStorage.getItem('only'),
      walnutToken: localStorage.getItem('walnut.vault.session'),
      parentStorage: read(() => window.parent.localStorage.getItem('walnut.vault.session')),
      origin: self.origin,
      keys: localStorage.length,
    }
  })
  expect(seen).toEqual({ sessionSeesLocal: null, localOnly: 'local', sessionOnly: 'session', walnutToken: null, parentStorage: expect.stringMatching(/^blocked:/), origin: 'null', keys: 1 })
  await page.waitForTimeout(1200)
  // Walnut's own storage and cookies hold nothing of the page's.
  const walnut = await page.evaluate(() => ({ only: localStorage.getItem('only'), cookie: document.cookie }))
  expect(walnut.only).toBeNull()
  expect(walnut.cookie).not.toContain('pagecookie')
  expect((await context.cookies()).map((c) => c.name)).not.toContain('pagecookie')
  // Another file's page gets none of it.
  const other = await openFile(page, explorer, b, 'version 1')
  expect(await shown(other)).toEqual({ ls: 'none', ss: 'none', ck: 'none', idb: 'none', cache: 'none', est: 'ok' })
})

test('every storage API the page sees is listed with what the preview does with it', async ({ page }) => {
  const name = `storage-apis-${Date.now()}.html`
  await scratchHtml(page, name, pageHtml(1))
  const explorer = await openFiles(page)
  const frame = await openFile(page, explorer, name, 'version 1')
  await shown(frame)
  const names = await frame.locator('body').evaluate((_, src) => {
    const re = new RegExp(src, 'i')
    const found = new Set<string>()
    const walk = (o: object, pre: string) => {
      for (let x: object | null = o; x && x !== Object.prototype; x = Object.getPrototypeOf(x)) {
        for (const k of Object.getOwnPropertyNames(x)) if (re.test(k)) found.add(pre + k)
      }
    }
    walk(window, ''); walk(navigator, 'navigator.'); walk(document, 'document.')
    return [...found].sort()
  }, STORAGE_API_PATTERN.source)
  const unlisted = names.filter((n) => !(n in STORAGE_APIS))
  expect(unlisted, 'a storage API the browser shows a preview page: list it in src/web/preview-storage-apis.ts with what the preview does with it').toEqual([])
  // Each one listed as working is there and answers without throwing.
  const works = names.filter((n) => STORAGE_APIS[n]?.kind === 'works')
  const broken = await frame.locator('body').evaluate((_, list) => list.filter((n) => {
    try {
      const [obj, key] = n.startsWith('navigator.') ? [navigator, n.slice(10)] : n.startsWith('document.') ? [document, n.slice(9)] : [window, n]
      const v = (obj as unknown as Record<string, unknown>)[key]
      return v === undefined || v === null
    } catch { return true }
  }), works)
  expect(broken).toEqual([])
})

test('a page framing another file gets none of its storage, not through the frame\'s name either', async ({ page }) => {
  const a = `storage-kept-${Date.now()}.html`
  const x = `storage-framer-${Date.now()}.html`
  await scratchHtml(page, a, pageHtml(1))
  // The framer loads the file, then sends its frame to a page of its own that reads the frame's name.
  await scratchHtml(page, x, `<!doctype html><html><head><title>framer</title></head><body><h1>Framer</h1>
<p id="got">waiting</p><iframe id="f" width="600" height="200"></iframe>
<script>
  var f = document.getElementById('f'), n = 0;
  addEventListener('message', function(e){
    var s = String(e.data);
    document.getElementById('got').textContent = 'name ' + (s.indexOf('kept') >= 0 || s.indexOf('pc=') >= 0 || s.indexOf('hello') >= 0 ? 'leaked' : 'clean');
  });
  f.onload = function(){
    if (n++) return;
    setTimeout(function(){ f.src = 'data:text/html,' + encodeURIComponent('<script>parent.postMessage(String(name), "*")</' + 'script>'); }, 1500);
  };
  f.src = ${JSON.stringify(a)};
</script></body></html>`)
  const explorer = await openFiles(page)
  const frame = await openFile(page, explorer, a, 'version 1')
  await shown(frame)
  await writeEverything(frame)
  const framer = await openFile(page, explorer, x, 'Framer')
  // The framed file sees none of what it kept.
  const inner = framer.frameLocator('#f')
  await expect(inner.locator('#idb')).not.toHaveText('?', { timeout: 10_000 })
  expect(await inner.locator('#ls').textContent()).toBe('none')
  expect(await inner.locator('#idb').textContent()).toBe('none')
  // And its frame's name, read after it left, holds nothing of it.
  await expect(framer.locator('#got')).toHaveText('name clean', { timeout: 10_000 })
  // The file itself still has all of it.
  const again = await openFile(page, explorer, a, 'version 1')
  expect((await shown(again)).ls).toBe('kept')
})
