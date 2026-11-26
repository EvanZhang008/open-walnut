/**
 * A push approval asked while the person is away is held, and reaches him when he is back, one tap
 * (src/core/approvals/held-asks.ts; 2026-11-25, Walnut VP: refused as user_away with "do not ask
 * again", nobody asked again, and a Slack fix waited five days).
 *
 * The Git gate's ask goes through the real fence and store on the fixture server. Two things the
 * fixture server cannot have are stood in by its held-approval action: the person's presence (away,
 * then back) and the asking task's session (the sweep's "ask again" notice is recorded; the spec
 * then asks again as that task would).
 * Record: APR_VIDEO=1 bun x playwright test approvals-held
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { holdApprovalsLock } from './approvals-lock'
import { isolateUiPrefsContext } from './status-section-helpers'

test.use({ video: process.env.APR_VIDEO || process.env.PW_VIDEO ? 'on' : 'off', viewport: { width: 1440, height: 900 } })
test.describe.configure({ mode: 'serial' })
test.beforeEach(async ({ context }) => { await isolateUiPrefsContext(context) })
holdApprovalsLock('file', { clear: true })

const fixture = async (request: APIRequestContext, data: Record<string, unknown>) => {
  const res = await request.post('/api/test/host-fixture', { data })
  expect(res.status(), await res.text()).toBe(200)
  return await res.json() as Record<string, unknown>
}

/** A line on top of the page saying what happens now (the recording's caption; it takes no clicks). */
async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById('spec-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'spec-caption'
      el.setAttribute('style', 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;'
        + 'background:#1f2937;color:#f9fafb;padding:10px 18px;border-radius:10px;font:600 18px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)')
      document.body.appendChild(el)
    }
    el.textContent = t
  }, text)
  if (process.env.APR_VIDEO) await page.waitForTimeout(1_800)
}

test('away: the push ask is held and nothing rings; back: its task asks again and one tap approves it', async ({ page, request }) => {
  const task = `t-held-${Date.now().toString(36)}`
  const ask = () => fixture(request, {
    action: 'git-push-approval', fenced: true, host: 'build-box', taskId: task, sessionId: `s-${task}`,
    taskTitle: 'Docs Site · Weekly Deploy', repository: '/home/dev/work/docs-site', branch: 'main',
  })
  try {
    await page.goto('/')
    await expect(page.locator('.app-layout, #root').first()).toBeVisible()
    await page.getByTestId('sidebar-core-app-settings').click()
    await expect(page).toHaveURL(/\/settings/)
    const cards = page.locator('[data-testid="approval-card"]')

    await fixture(request, { action: 'held-approval', op: 'clear' })
    await fixture(request, { action: 'held-approval', op: 'away' })
    await caption(page, '1  用户不在：任务的 Git 推送要审批')
    const first = await ask() as { refused?: { code: string; message: string } }
    // Away, or (another spec's ask denied lately and nothing since) the retry fence: both hold it.
    expect(['user_away', 'unanswered_retry']).toContain(first.refused?.code)
    expect(first.refused?.message).toContain('Walnut holds this ask')
    const heldId = /\((held-[\w-]+)\)/.exec(first.refused!.message)?.[1]
    expect(heldId).toBeTruthy()
    await caption(page, '1  Walnut 先排着（不推到设备，也不作废）')
    await expect(cards).toHaveCount(0)

    await caption(page, '2  任务再问一次：还是同一条，不重复问')
    const again = await ask() as { refused?: { message: string } }
    expect(again.refused?.message).toContain(heldId!)
    const listed = await fixture(request, { action: 'held-approval', op: 'list' }) as { held: Array<{ id: string; state: string; requester: { taskId: string } }> }
    expect(listed.held.filter((h) => h.requester.taskId === task).map((h) => [h.id, h.state])).toEqual([[heldId, 'held']])
    // Nothing goes while he is away.
    expect((await fixture(request, { action: 'held-approval', op: 'sweep' }) as { told: unknown[] }).told).toEqual([])
    await expect(cards).toHaveCount(0)

    await caption(page, '3  用户回到 Walnut')
    await fixture(request, { action: 'held-approval', op: 'present' })
    await fixture(request, { action: 'held-approval', op: 'sweep' })
    // Told once, by this sweep or the server's own minute clock, whichever ran first.
    const told = await fixture(request, { action: 'held-approval', op: 'list' }) as { told: Array<{ kind: string; held: { id: string } }> }
    expect(told.told.filter((t) => t.held.id === heldId).map((t) => t.kind)).toEqual(['release'])
    await caption(page, '3  Walnut 通知任务：现在重新发起')

    // The task takes the step again, as the notice says: its ask now goes to his devices.
    const asked = await ask() as { approval?: { id: string }; refused?: unknown }
    expect(asked.refused).toBeUndefined()
    const card = page.locator(`[data-testid="approval-card"][data-approval-id="${asked.approval!.id}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await caption(page, '4  推到用户面前，一点就批')
    await expect(card).toContainText('Push commit da21d9c to origin main in docs-site')
    await card.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.locator(`.approval-card-settled[data-approval-id="${asked.approval!.id}"]`)).toContainText('Approved')
    await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${asked.approval!.id}`)).json()).approval.status).toBe('approved')
    const after = await fixture(request, { action: 'held-approval', op: 'list' }) as { held: Array<{ id: string; state: string; askedAs?: string }> }
    expect(after.held.find((h) => h.id === heldId)).toMatchObject({ state: 'asked', askedAs: asked.approval!.id })
    await caption(page, '已批准：排着的那条记为已问，不会再问第二次')
  } finally {
    await fixture(request, { action: 'held-approval', op: 'real' })
  }
})
