import { test, expect, type Page, type Locator } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

test.use({ viewport: { width: 1200, height: 800 } })

const SID = 'pw-vscode-session'
const TASK = 'pw-task-vscode'
const preview = (p: Page) => p.locator('.fv-wysiwyg-editor .ProseMirror')
const source = (p: Page) => p.locator('.fv-source-editor .cm-content')
const save = (p: Page) => p.locator('.fv-save-btn')
const live = (p: Page) => p.locator('.fv-live-toggle')
const error = (p: Page) => p.locator('.fv-save-error')
const body = (dense = false) => `---
title: Sample design
revision: 1
---
# Design review

Editable introduction: original.

External paragraph: original.

| Option | Latency | Decision |
|:--|--:|:--:|
| Alpha | 12 ms | pending |
| Beta | 24 ms | pending |

- **Requirement:** preserve edits
- Unicode: café 中文 naïve

\`\`\`ts
const version = 1;
\`\`\`

${dense ? Array.from({ length: 160 }, (_, i) => `## Detail ${i}\n\nParagraph ${i}: ${'A neutral design statement about ownership and safe updates. '.repeat(4)}\n`).join('\n') : ''}Final paragraph.
`

async function event(p: Page, name: string, data: Record<string, unknown>) {
  await p.waitForFunction(() => (window as any).testSocket?.readyState === 1)
  await p.evaluate(({ name, data }) => {
    (window as any).testSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data }) }))
  }, { name, data })
}
async function tool(p: Page, name = 'Bash') {
  const data = { sessionId: SID, toolUseId: `matrix-${Date.now()}-${Math.random()}`, toolName: name, input: { command: 'update scratch file' } }
  await event(p, 'session:tool-use', data)
  await event(p, 'session:tool-result', data)
}
async function open(p: Page, text: string, ext = 'md') {
  const res = await p.request.get(`/api/sessions/${SID}`)
  expect(res.ok()).toBe(true)
  const data = await res.json()
  const cwd = data.session?.cwd ?? data.cwd
  expect(cwd).toMatch(/walnut-pw-/)
  const name = `matrix-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const abs = `${cwd}/${name}`
  await writeFile(abs, text)
  await p.locator('.todo-search-input').fill(SID)
  const row = p.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
  await row.locator('.todo-item-title').click()
  const panel = p.locator(`.session-panel[data-session-id="${SID}"]`)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..').click()
  await expect(preview(p)).toContainText('Design review')
  await expect(save(p)).toBeDisabled()
  return { abs, name, explorer, panel }
}
async function setLive(p: Page, on: boolean) {
  if ((await live(p).getAttribute('aria-pressed')) !== String(on)) await live(p).click()
  await expect(live(p)).toHaveAttribute('aria-pressed', String(on))
}
async function replace(p: Page, locator: Locator, needle: string, replacement: string) {
  await locator.click()
  await locator.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const at = (node.textContent ?? '').indexOf(needle)
      if (at < 0) continue
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      return
    }
    throw new Error('Selection text not found')
  }, needle)
  await p.keyboard.insertText(replacement)
}
async function settled(p: Page, abs: string, ours: string, theirs: string) {
  await expect.poll(() => readFile(abs, 'utf8'), { timeout: 12000 }).toContain(ours)
  await expect.poll(() => readFile(abs, 'utf8')).toContain(theirs)
  await expect(preview(p)).toContainText(ours)
  await expect(preview(p)).toContainText(theirs)
  await expect(save(p)).toBeDisabled()
  await expect(error(p)).toHaveCount(0)
  await expect(live(p)).not.toHaveClass(/suspended/)
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
    localStorage.setItem('open-walnut-live-edit', '0')
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as any).testSocket = this
      }
    }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 15000 })
})

test('dense Markdown stays clean through five script updates and selection', async ({ page }) => {
  const initial = body(true)
  expect(initial.length).toBeGreaterThan(40000)
  const { abs } = await open(page, initial)
  await setLive(page, true)
  const puts: string[] = []
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/api/file-content')) puts.push(r.postData() ?? '') })
  for (let i = 1; i <= 5; i++) {
    const text = initial.replace('External paragraph: original.', `External paragraph: script-${i}.`)
    await writeFile(abs, text); await tool(page)
    await expect(preview(page)).toContainText(`script-${i}`)
    await preview(page).getByRole('heading', { name: 'Design review', exact: true }).dblclick()
    await page.keyboard.press('ArrowRight')
    await expect(save(page)).toBeDisabled()
    await expect(error(page)).toHaveCount(0)
    expect(await readFile(abs, 'utf8')).toBe(text)
  }
  await page.waitForTimeout(1000)
  expect(puts).toEqual([])
})

test('Markdown user paragraph and external table edit merge without false conflict', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  await writeFile(abs, initial.replace('| Beta | 24 ms | pending |', '| Beta | 18 ms | approved |'))
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'human-edit')
  await tool(page)
  await settled(page, abs, 'human-edit', 'approved')
  expect(await readFile(abs, 'utf8')).toContain('revision: 1')
})

test('different table cells in one row merge without blocking either edit', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  await writeFile(abs, initial.replace('| Alpha | 12 ms | pending |', '| Alpha | 12 ms | approved |'))
  await replace(page, preview(page).locator('td').filter({ hasText: '12 ms' }), '12', '10')
  await tool(page)
  await settled(page, abs, '10 ms', 'approved')
})

test('a long table row preserves separated edits without losing surrounding text', async ({ page }) => {
  const detail = 'Long cell with repeated design context. '.repeat(140)
  const initial = body().replace('| Alpha | 12 ms | pending |', `| Alpha ${detail} | 12 ms | pending |`)
  const { abs } = await open(page, initial)
  await setLive(page, true)
  await writeFile(abs, initial.replace('| 12 ms | pending |', '| 12 ms | approved |'))
  await replace(page, preview(page).locator('td').filter({ hasText: '12 ms' }), '12', '10')
  await tool(page)
  await settled(page, abs, '10 ms', 'approved')
  expect(await readFile(abs, 'utf8')).toContain(detail.trim())
})

test('different words in one paragraph merge without a false overlap', async ({ page }) => {
  const initial = body().replace('Editable introduction: original.', 'Editable introduction: latency 12 ms and retry limit 3.')
  const { abs } = await open(page, initial)
  await setLive(page, true)
  await writeFile(abs, initial.replace('retry limit 3', 'retry limit 5'))
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), '12', '10')
  await tool(page)
  await settled(page, abs, 'latency 10 ms', 'retry limit 5')
})

test('ten alternating Markdown typing bursts and script updates stay writable', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  for (let i = 1; i <= 10; i++) {
    const disk = await readFile(abs, 'utf8')
    await writeFile(abs, disk.replace(/External paragraph: [^.]+\./, `External paragraph: script-${i}.`))
    await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), i === 1 ? 'original' : `human-${i - 1}`, `human-${i}`)
    await tool(page)
    await settled(page, abs, `human-${i}`, `script-${i}`)
  }
})

test('Live off merges Markdown in memory without saving and survives file switch', async ({ page }) => {
  const initial = body()
  const { abs, explorer } = await open(page, initial)
  const other = abs.replace('.md', '-other.md')
  await writeFile(other, '# Other file\n\nOther content.\n')
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'unsaved-human')
  const updated = initial.replace('External paragraph: original.', 'External paragraph: script-edit.')
  await writeFile(abs, updated); await tool(page)
  await expect(preview(page)).toContainText('unsaved-human')
  await expect(preview(page)).toContainText('script-edit')
  await expect(save(page)).toBeEnabled()
  expect(await readFile(abs, 'utf8')).toBe(updated)
  await explorer.getByRole('button', { name: 'Refresh file panel', exact: true }).click()
  await explorer.locator('.sfe-name', { hasText: other.split('/').pop()! }).locator('xpath=..').click()
  await expect(preview(page)).toContainText('Other content')
  await explorer.locator('.sfe-name', { hasText: abs.split('/').pop()! }).locator('xpath=..').click()
  await expect(preview(page)).toContainText('unsaved-human')
  await expect(preview(page)).toContainText('script-edit')
  await expect(error(page)).toHaveCount(0)
})

test('true Markdown conflict preserves both versions and Discard resumes clean editing', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  const theirs = initial.replace('Editable introduction: original.', 'Editable introduction: external-choice.')
  await writeFile(abs, theirs)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'human-choice')
  await tool(page)
  await expect(error(page)).toContainText('overlap')
  await expect(live(page)).toHaveClass(/suspended/)
  await expect(preview(page)).toContainText('human-choice')
  expect(await readFile(abs, 'utf8')).toBe(theirs)
  for (let i = 0; i < 3; i++) await tool(page)
  await page.waitForTimeout(800)
  expect(await readFile(abs, 'utf8')).toBe(theirs)
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.locator('.app-modal').getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(preview(page)).toContainText('external-choice')
  await expect(error(page)).toHaveCount(0)
  await expect(save(page)).toBeDisabled()
  if ((await live(page).getAttribute('class'))?.includes('suspended')) await live(page).click()
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'external-choice', 'after-resolution')
  await settled(page, abs, 'after-resolution', 'External paragraph: original.')
})

test('cancelling Discard keeps both conflicting versions untouched', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  const theirs = initial.replace('Editable introduction: original.', 'Editable introduction: external-choice.')
  await writeFile(abs, theirs)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'human-choice')
  await tool(page)
  await expect(error(page)).toContainText('overlap')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.locator('.app-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(preview(page)).toContainText('human-choice')
  await expect(live(page)).toHaveClass(/suspended/)
  await expect(save(page)).toBeEnabled()
  expect(await readFile(abs, 'utf8')).toBe(theirs)
})

test('true conflict requires an explicit second Save before replacing disk', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  const theirs = initial.replace('Editable introduction: original.', 'Editable introduction: external-choice.')
  await writeFile(abs, theirs)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'human-choice')
  await tool(page)
  await expect(error(page)).toContainText('overlap')
  await save(page).click()
  await expect(error(page)).toContainText('Press Save again')
  expect(await readFile(abs, 'utf8')).toBe(theirs)
  await expect(preview(page)).toContainText('human-choice')
  await save(page).click()
  await expect(save(page)).toBeDisabled()
  expect(await readFile(abs, 'utf8')).toContain('human-choice')
  await expect(error(page)).toHaveCount(0)
})

test('Markdown keystrokes during a delayed write reach disk without self-conflict', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  let release!: () => void
  const held = new Promise<void>(r => release = r)
  let count = 0
  const conflicts: number[] = []
  await page.route('**/api/file-content', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const index = ++count
    const response = await route.fetch()
    if (index === 1) await held
    if (response.status() === 409) conflicts.push(index)
    await route.fulfill({ response })
  })
  try {
    await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'first-burst')
    await expect.poll(() => count).toBe(1)
    await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'first-burst', 'second-burst')
    release()
    await settled(page, abs, 'second-burst', 'External paragraph: original.')
    expect(conflicts).toEqual([])
  } finally { release() }
})

test('Preview and Source switches preserve unsaved Markdown and save once', async ({ page }) => {
  const { abs } = await open(page, body())
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'cross-mode-edit')
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(source(page)).toContainText('cross-mode-edit')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(preview(page)).toContainText('cross-mode-edit')
  await save(page).click()
  await expect(save(page)).toBeDisabled()
  expect(await readFile(abs, 'utf8')).toContain('cross-mode-edit')
  await expect(error(page)).toHaveCount(0)
})

test('failed disk read recovers on the next event without replacing unsaved Markdown', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'unsaved-human')
  let rejected = 0
  await page.route('**/api/file-content?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('path') === abs && url.searchParams.get('track') === 'agent' && rejected === 0) { rejected++; return route.abort('failed') }
    return route.fallback()
  })
  const updated = initial.replace('External paragraph: original.', 'External paragraph: recovered.')
  await writeFile(abs, updated); await tool(page)
  await expect.poll(() => rejected).toBe(1)
  await expect(preview(page)).toContainText('unsaved-human')
  await page.waitForTimeout(500)
  await tool(page)
  await expect(preview(page)).toContainText('recovered')
  await expect(preview(page)).toContainText('unsaved-human')
  await expect(error(page)).toHaveCount(0)
  expect(await readFile(abs, 'utf8')).toBe(updated)
})

test('a visible Markdown file follows terminal writes with no tool event', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await writeFile(abs, initial.replace('External paragraph: original.', 'External paragraph: terminal-update.'))
  await expect(preview(page)).toContainText('terminal-update', { timeout: 35000 })
  await expect(save(page)).toBeDisabled()
  await expect(error(page)).toHaveCount(0)
  await expect(live(page)).toHaveAttribute('aria-pressed', 'false')
})

test('matching edits on both sides do not stop Live or duplicate the text', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await setLive(page, true)
  await writeFile(abs, initial.replace('Editable introduction: original.', 'Editable introduction: same-edit.'))
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'same-edit')
  await tool(page)
  await settled(page, abs, 'same-edit', 'External paragraph: original.')
  expect((await readFile(abs, 'utf8')).match(/same-edit/g)).toHaveLength(1)
})

test('editing again after a clean external adoption uses the new Markdown base', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'first-save')
  await settled(page, abs, 'first-save', 'External paragraph: original.')
  const disk = await readFile(abs, 'utf8')
  await writeFile(abs, disk.replace('External paragraph: original.', 'External paragraph: adopted.'))
  await tool(page)
  await expect(preview(page)).toContainText('adopted')
  await expect(save(page)).toBeDisabled()
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'first-save', 'second-save')
  await settled(page, abs, 'second-save', 'adopted')
})

test('an external formatting change after editing does not make the next edit self-conflict', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'first-save')
  await settled(page, abs, 'first-save', 'External paragraph: original.')
  const disk = await readFile(abs, 'utf8')
  const formatted = disk.replace('| Alpha | 12 ms | pending |', '| Alpha    | 12 ms  | pending  |').replace('External paragraph: original.', 'External paragraph: formatted.') + '\n'
  await writeFile(abs, formatted); await tool(page)
  await expect(preview(page)).toContainText('formatted')
  await expect(save(page)).toBeDisabled()
  const rejected: number[] = []
  page.on('response', r => { if (r.request().method() === 'PUT' && r.url().includes('/api/file-content') && r.status() === 409) rejected.push(r.status()) })
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'first-save', 'second-save')
  await settled(page, abs, 'second-save', 'formatted')
  expect(rejected, '只有自己的编辑，不应与刚接收的磁盘版本发生冲突').toEqual([])
})

test('a formatting change merged into dirty Markdown settles cleanly', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  const intro = preview(page).locator('p').filter({ hasText: 'Editable introduction:' })
  await replace(page, intro, 'original', 'first-save')
  await settled(page, abs, 'first-save', 'External paragraph: original.')
  const disk = await readFile(abs, 'utf8')
  const updated = disk.replace('| Alpha | 12 ms | pending |', '| Alpha    | 12 ms  | pending  |').replace('External paragraph: original.', 'External paragraph: concurrent-format.') + '\n'
  await writeFile(abs, updated)
  await replace(page, intro, 'first-save', 'second-save')
  await tool(page)
  await settled(page, abs, 'second-save', 'concurrent-format')
})

test('typing during a delayed formatting merge remains unsaved until its own write lands', async ({ page }) => {
  const { abs } = await open(page, body())
  await setLive(page, true)
  const intro = preview(page).locator('p').filter({ hasText: 'Editable introduction:' })
  await replace(page, intro, 'original', 'first-save')
  await settled(page, abs, 'first-save', 'External paragraph: original.')
  const disk = await readFile(abs, 'utf8')
  await writeFile(abs, disk.replace('| Alpha | 12 ms | pending |', '| Alpha    | 12 ms  | pending  |').replace('External paragraph: original.', 'External paragraph: concurrent-format.') + '\n')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let holding = false
  await page.route('**/api/file-content', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const response = await route.fetch()
    if (response.status() === 200 && !holding) { holding = true; await held }
    await route.fulfill({ response })
  })
  try {
    await replace(page, intro, 'first-save', 'second-save')
    await tool(page)
    await expect.poll(() => holding).toBe(true)
    await replace(page, intro, 'second-save', 'third-save')
    await expect(save(page)).toBeEnabled()
    await expect(page.locator('.fv-dirty-dot')).toBeVisible()
    expect(await readFile(abs, 'utf8')).not.toContain('third-save')
    release()
    await settled(page, abs, 'third-save', 'concurrent-format')
  } finally { release() }
})

test('Discard uses disk changes received while its confirmation is open', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'unsaved-human')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  const changed = initial.replace('Editable introduction: original.', 'Editable introduction: latest-disk.')
  await writeFile(abs, changed)
  await tool(page)
  await expect(error(page)).toContainText('overlap')
  await page.locator('.app-modal').getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(preview(page)).toContainText('latest-disk')
  await expect(save(page)).toBeDisabled()
  await setLive(page, true)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'latest-disk', 'after-dialog')
  await settled(page, abs, 'after-dialog', 'External paragraph: original.')
})

test('a missing-file response never replaces the dirty Markdown buffer', async ({ page }) => {
  const initial = body()
  const { abs } = await open(page, initial)
  await replace(page, preview(page).locator('p').filter({ hasText: 'Editable introduction:' }), 'original', 'unsaved-human')
  let missing = 0
  await page.route('**/api/file-content?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('path') === abs && url.searchParams.get('track') === 'agent' && missing === 0) { missing++; return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'File not found' }) }) }
    return route.fallback()
  })
  await tool(page)
  await expect.poll(() => missing).toBe(1)
  await expect(preview(page)).toContainText('unsaved-human')
  await page.waitForTimeout(500)
  const updated = initial.replace('External paragraph: original.', 'External paragraph: recreated.')
  await writeFile(abs, updated); await tool(page)
  await expect(preview(page)).toContainText('recreated')
  await expect(preview(page)).toContainText('unsaved-human')
  expect(await readFile(abs, 'utf8')).toBe(updated)
})

test('CRLF and frontmatter external updates do not create automatic dirty writes', async ({ page }) => {
  const initial = body().replace(/\n/g, '\r\n')
  const { abs } = await open(page, initial)
  await setLive(page, true)
  const puts: string[] = []
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/api/file-content')) puts.push(r.url()) })
  const updated = initial.replace('revision: 1', 'revision: 2').replace('External paragraph: original.', 'External paragraph: fresh.')
  await writeFile(abs, updated); await tool(page)
  await expect(preview(page)).toContainText('External paragraph: fresh.')
  await expect(save(page)).toBeDisabled()
  await page.waitForTimeout(900)
  expect(await readFile(abs, 'utf8')).toBe(updated)
  expect(puts).toEqual([])
})
