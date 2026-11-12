// Local demo walk for the simplified approval dialog (not committed): records a WebKit video.
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import { holdApprovalsLock } from './approvals-lock'

holdApprovalsLock('test', { clear: true })

const OUT = '/tmp/approval-simplify'
fs.mkdirSync(OUT, { recursive: true })
test.use({ viewport: { width: 1280, height: 800 }, video: 'on' })

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('approval dialog: sentence, command, task, folded detail', async ({ page, request }, info) => {
  test.setTimeout(240_000)
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await page.getByRole('link', { name: /Tasks/ }).first().click().catch(() => {})
  const context = JSON.stringify({
    argv: ['git', '-C', '/home/dev/.local/state/open-walnut/tasks/de593da8/scratch', 'push', 'origin', 'cd-3-timeout'],
    command: 'git -C /home/dev/.local/state/open-walnut/tasks/de593da8/scratch push origin cd-3-timeout',
    commitSha: '0fa0f761c9d5ae33c7d2e93142d3b9088d61b9dc', cwd: '/local/home/dev/.local/state/open-walnut/tasks/de593da8/scratch',
    localRef: 'refs/heads/cd-3-timeout', operation: 'push', remote: 'origin', remoteRef: 'refs/heads/cd-3-timeout',
    remoteUrl: 'ssh://git.example.test/scratch.git', repository: '/local/home/dev/.local/state/open-walnut/tasks/de593da8/scratch',
  })
  const git = await request.post('/api/v1/approvals', {
    headers: { 'x-walnut-caller-sid': 'pw-provenance-session' },
    data: {
      what: 'Push commit 0fa0f76 to branch cd-3-timeout on origin (scratch repo)?',
      cwd: '/local/home/dev/.local/state/open-walnut/tasks/de593da8/scratch',
      command: 'git -C /home/dev/.local/state/open-walnut/tasks/de593da8/scratch push origin cd-3-timeout',
      detail: context, timeout_ms: 300_000,
    },
  })
  expect(git.ok()).toBe(true)
  const gitId = (await git.json() as { approval: { id: string } }).approval.id
  const card = page.locator(`.corner-stack [data-testid="approval-card"][data-approval-id="${gitId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await pause(1500)
  await page.screenshot({ path: `${OUT}/${info.project.name}-card.png` })
  await card.getByTestId('approval-what').click()
  const dialog = page.getByTestId('approval-dialog')
  await expect(dialog).toBeVisible()
  await pause(2000)
  await dialog.locator('.approval-dialog').screenshot({ path: `${OUT}/${info.project.name}-dialog.png` })
  await dialog.locator('.approval-detail summary').click()
  await pause(2000)
  await dialog.locator('.approval-dialog').screenshot({ path: `${OUT}/${info.project.name}-dialog-detail.png` })
  await dialog.locator('.approval-detail pre').evaluate((n) => n.scrollBy({ top: 200, behavior: 'smooth' }))
  await pause(1200)
  await dialog.locator('.approval-detail summary').click()
  await pause(1000)
  await dialog.locator('.approval-dialog-close').click()
  await pause(800)

  // A second one, from a script with no task, with its own line.
  const plain = await request.post('/api/v1/approvals', {
    data: { what: 'Publish the release notes to the website?', why: 'The notes for v0.9 are ready and checked.', cwd: '/work/site', command: 'release.sh --notes v0.9', detail: 'notes: 4 lines\npages: changelog' },
  })
  expect(plain.ok()).toBe(true)
  const plainId = (await plain.json() as { approval: { id: string } }).approval.id
  await expect(card.getByTestId('approval-count')).toHaveText(/^2 waiting/, { timeout: 15_000 })
  await pause(1200)
  await card.getByTestId('approval-count').click()
  await expect(dialog).toBeVisible()
  await pause(1200)
  await dialog.getByTestId('approval-dialog-list').locator('li').nth(1).locator('button').click()
  await pause(1800)
  await dialog.locator('.approval-dialog').screenshot({ path: `${OUT}/${info.project.name}-dialog-no-task.png` })
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await pause(1500)
  await dialog.getByTestId('approval-dialog-next').click()
  await pause(1500)
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('approval-dialog-settled')).toContainText('Approved')
  await pause(1500)
  const st = await (await request.get(`/api/v1/approvals`)).json() as { approvals: Array<{ id: string; status: string }> }
  console.log('statuses', JSON.stringify(st.approvals.filter((a) => [gitId, plainId].includes(a.id)).map((a) => [a.id, a.status])))
  await page.close()
  const v = page.video()
  if (v) await v.saveAs(`${OUT}/${info.project.name}-walk.webm`)
})

test('approvals switch: stop asking from the card, off in Settings, on again', async ({ page, request }, info) => {
  test.setTimeout(240_000)
  const setAskMe = (v: boolean) => request.put('/api/config', { data: { approvals: { ask_me: v } } })
  await setAskMe(true)
  try {
    await page.goto('/')
    await expect(page.locator('.app-layout, #root').first()).toBeVisible()
    await page.getByTestId('sidebar-core-app-settings').click()
    await page.getByTestId('settings-nav-general').click()
    const toggle = page.locator('#settings-approvals-ask-me')
    await toggle.scrollIntoViewIfNeeded()
    await pause(1500)
    const post = await request.post('/api/v1/approvals', { data: { what: 'Post the release notes to #team-updates?', command: 'post-notes.sh', cwd: '/work/site', detail: 'channel: #team-updates\nlines: 6' } })
    const id = (await post.json() as { approval: { id: string } }).approval.id
    const card = page.locator(`.corner-stack [data-testid="approval-card"][data-approval-id="${id}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await pause(2500)
    await page.screenshot({ path: `${OUT}/switch-card.png` })
    await card.getByTestId('approval-stop-asking').hover()
    await pause(1200)
    await card.getByTestId('approval-stop-asking').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
    await pause(2500)
    await page.screenshot({ path: `${OUT}/switch-off.png` })
    // Off: the next one goes ahead, no card.
    const quiet = await request.post('/api/v1/approvals', { data: { what: 'Post the changelog to #team-updates?', command: 'post-notes.sh', cwd: '/work/site' } })
    console.log('off ->', JSON.stringify((await quiet.json() as { approval: { status: string; unasked?: string } }).approval))
    await pause(3000)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await pause(1500)
    const again = await request.post('/api/v1/approvals', { data: { what: 'Delete the old preview site?', command: 'cleanup.sh', cwd: '/work/site' } })
    const againId = (await again.json() as { approval: { id: string } }).approval.id
    const card2 = page.locator(`.corner-stack [data-testid="approval-card"][data-approval-id="${againId}"]`)
    await expect(card2).toBeVisible({ timeout: 15_000 })
    await pause(2500)
    await card2.getByRole('button', { name: 'Deny' }).click()
    await pause(2000)
  } finally {
    await setAskMe(true)
  }
  await page.close()
  const v = page.video()
  if (v) await v.saveAs(`${OUT}/${info.project.name}-switch.webm`)
})
