import { expect, test } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { keepTaskFramesTo } from './task-list-stub'

const SID = 'pw-store-sync-session'
const TID = 'pw-task-store-sync'

test.use({ viewport: { width: 1280, height: 860 } })
test('measure visible and hidden session costs across repeated Org visits', async ({ page, browserName }, testInfo) => {
  test.setTimeout(240_000)
  await isolateUiPrefs(page)
  const orgSid = 'pw-chat-content-session'
  const project = 'Ledger memory'
  const lead = { id: 'pw-ledger-org-lead', title: `${project} VP`, project, org_role: 'lead',
    walnut_agent: true, phase: 'IN_PROGRESS', status: 'in_progress', session_id: orgSid,
    session_ids: [orgSid], source: 'local', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const ownTaskIds = new Set<string>([lead.id])
  await keepTaskFramesTo(page, ownTaskIds)
  await page.route('**/api/tasks?*', async route => {
    const response = await route.fetch()
    const data = await response.json()
    if (Array.isArray(data.tasks)) {
      for (const task of data.tasks) ownTaskIds.add(task.id)
      data.tasks = [...data.tasks, lead]
    }
    await route.fulfill({ response, json: data })
  })
  await page.route(`**/api/tasks/${lead.id}`, route => route.fulfill({ json: { task: lead } }))
  const rows = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    text: `Dense transcript row ${i}\n\n${'Preserved conversation detail. '.repeat(100)}`,
    msgId: `ledger-row-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
  for (const sid of [SID, orgSid]) await page.route(`**/api/sessions/${sid}/history**`, route => route.fulfill({ json: {
    messages: rows, total: rows.length, cursor: rows.length, delta: false,
  } }))
  await page.addInitScript(() => {
    const counts = { visible: 0, hidden: 0, stacks: {} as Record<string, number> }
    ;(window as any).__ledgerReads = counts
    const count = (el: Element) => {
      if (!el.closest('.session-panel')) return
      const hidden = !!el.closest('.main-page-wrapper-hidden')
      counts[hidden ? 'hidden' : 'visible']++
      if (hidden) {
        const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') ?? 'unknown'
        counts.stacks[stack] = (counts.stacks[stack] ?? 0) + 1
      }
    }
    for (const key of ['scrollHeight', 'clientHeight']) {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, key)!
      Object.defineProperty(Element.prototype, key, { ...desc, get(this: Element) { count(this); return desc.get!.call(this) } })
    }
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { count(this); return rect.call(this) }
  })
  let windowName = 'boot'
  const requests: Record<string, Record<string, number>> = {}
  const responses: Array<{ window: string; url: string; bytes: number }> = []
  page.on('request', req => {
    const url = new URL(req.url())
    if (!url.pathname.startsWith(`/api/sessions/${SID}/`)) return
    const group = requests[windowName] ??= {}
    group[url.pathname.split('/').at(-1)!] = (group[url.pathname.split('/').at(-1)!] ?? 0) + 1
  })
  page.on('response', async res => {
    if (!res.url().includes(`/api/sessions/${SID}/history`)) return
    const captured = windowName
    try { responses.push({ window: captured, url: new URL(res.url()).pathname + new URL(res.url()).search, bytes: (await res.body()).length }) } catch { /* closed */ }
  })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await loadHome(page)
  await page.locator('.todo-search-input').fill(SID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TID}"]`)
  await expect(row).toBeVisible()
  await row.locator('.todo-item-title').click()
  const history = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"] .session-history`)
  await expect(history).toContainText('Dense transcript row 399')
  await page.waitForTimeout(2500)
  const reads = () => page.evaluate(() => ({ ...(window as any).__ledgerReads }))
  const visibleStart = await reads()
  windowName = 'visible'
  await page.waitForTimeout(60_000)
  const visibleEnd = await reads()
  const openOrg = async () => {
    await page.getByTestId('sidebar-org').click()
    await expect(page.getByTestId('org-page')).toBeVisible()
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
    await expect(page.getByTestId('org-chat')).toContainText('Dense transcript row 399')
  }
  await openOrg()
  await page.waitForTimeout(2500)
  windowName = 'hidden'
  const hiddenStart = await reads()
  await page.waitForTimeout(60_000)
  const hiddenEnd = await reads()
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  let heapEnabled = false
  const memory = async () => {
    let heap: number | null = null
    if (cdp) {
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
      heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
    } else if (browserName === 'webkit') {
      const impl = (page as any)._connection.toImpl(page)
      const session = impl.delegate._session
      if (!heapEnabled) { await session.send('Heap.enable'); heapEnabled = true }
      await session.send('Heap.gc')
      const snapshot = JSON.parse((await session.send('Heap.snapshot')).snapshotData)
      // JavaScriptCore Inspector v3 stores [id, size, classNameIndex, flags].
      if (snapshot.version !== 3 || snapshot.type !== 'Inspector' || snapshot.nodes.length % 4 !== 0) {
        throw new Error(`Unexpected WebKit heap format: ${JSON.stringify(Object.keys(snapshot))}`)
      }
      heap = 0
      for (let i = 1; i < snapshot.nodes.length; i += 4) heap += snapshot.nodes[i]
    }
    return { nodes: await page.evaluate(() => document.getElementsByTagName('*').length), heap }
  }
  const before = await memory()
  const cycles = []
  windowName = 'cycles'
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('sidebar-core-app-home').click()
    await expect(history).toBeVisible()
    await openOrg()
    await page.waitForTimeout(700)
    if (i === 3 || i === 7 || i === 11) cycles.push(await memory())
  }
  expect(cycles.at(-1)!.nodes, 'attached DOM stays bounded on repeated dense Org chat visits').toBeLessThanOrEqual(before.nodes + 20)
  const hiddenRequests = requests.hidden ?? {}
  expect(hiddenRequests.supervision ?? 0).toBe(0)
  expect(hiddenRequests.servers ?? 0).toBe(0)
  expect(hiddenEnd.hidden - hiddenStart.hidden, 'all layout reads in a hidden Home session').toBeLessThanOrEqual(2)
  console.log(`[ledger-cost] ${JSON.stringify({ browserName, requests, responses,
    layout: { visiblePerMinute: visibleEnd.visible - visibleStart.visible, hiddenPerMinute: hiddenEnd.hidden - hiddenStart.hidden },
    hiddenStacks: hiddenEnd.stacks, memory: { before, cycles }, errors })}`)
  await page.screenshot({ path: testInfo.outputPath(`ledger-${browserName}.png`), scale: 'css' })
  expect(errors).toEqual([])
})
