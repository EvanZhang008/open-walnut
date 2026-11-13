import { expect, test } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { captureWs, waitForWs } from './ws-capture-helpers'

test('large task fields arrive once while repeated edits and reconnects keep the board current', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const frames: Array<{ data: any; bytes: number }> = []
  const connections: string[] = []
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws') return
    connections.push(socket.url())
    socket.on('framereceived', ({ payload }) => {
      try {
        const text = String(payload)
        const frame = JSON.parse(text)
        if (frame.name === 'task:updated') frames.push({ data: frame.data, bytes: Buffer.byteLength(text) })
      } catch { /* non-JSON control frames */ }
    })
  })
  const created = await request.post('/api/tasks', { data: { title: 'Lean transport fixture', project: 'Lean transport' } })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).task.id as string
  try {
    await isolateUiPrefs(page)
    await captureWs(page)
    await loadHome(page)
    await waitForWs(page)
    expect(connections[0]).toContain('lean=')
    await page.locator('.todo-search-input').fill('Lean transport')
    const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`)
    await expect(row).toBeVisible()
    const note = 'A dense task note with preserved history.\n'.repeat(1000)
    const saved = await request.put(`/api/tasks/${id}/note`, { data: { content: note } })
    expect(saved.ok()).toBe(true)
    await expect.poll(() => frames.some(f => f.data.task?.id === id && f.data.task.note === note)).toBe(true)
    for (let i = 0; i < 3; i++) {
      const title = `Lean transport revision ${i}`
      const changed = await request.patch(`/api/tasks/${id}`, { data: { title } })
      expect(changed.ok()).toBe(true)
      await expect(row.locator('.todo-item-title')).toHaveText(title)
      const frame = frames.findLast(f => f.data.task?.id === id && f.data.task.title === title)
      expect(frame?.data.lean?.omit).toContain('note')
      expect(frame?.bytes).toBeLessThan(note.length / 2)
    }
    // A reconnect creates a fresh server baseline without reloading or losing the search.
    await page.evaluate(() => {
      const socket = (window as any).__capturedWs
      ;(window as any).__capturedWs = undefined
      socket.close()
    })
    await expect.poll(() => connections.length).toBeGreaterThan(1)
    await waitForWs(page)
    const changed = await request.patch(`/api/tasks/${id}`, { data: { title: 'Lean transport after reconnect' } })
    expect(changed.ok()).toBe(true)
    await expect(row.locator('.todo-item-title')).toHaveText('Lean transport after reconnect')
    const first = frames.findLast(f => f.data.task?.id === id && f.data.task.title === 'Lean transport after reconnect')
    expect(first?.data.task.note).toBe(note)
    expect(first?.data.lean?.keep).toContain('note')
    expect((await (await request.get(`/api/tasks/${id}`)).json()).task.note).toBe(note)
    expect(errors).toEqual([])
  } finally {
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})
