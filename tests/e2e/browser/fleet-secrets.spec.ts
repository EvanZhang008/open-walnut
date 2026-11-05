/**
 * Settings › Remote Hosts › More settings › Secrets (SecretsGroup.tsx; server:
 * src/core/secrets/fleet-secrets.ts): each secret with where its copies stand,
 * Add (name, value, what it is, hosts, env name, sessions) sending one PUT with
 * the value, the value never shown again, Edit to rotate or untick a host, a
 * refused Save that says why under the field it refuses and focuses it, Escape
 * as Cancel, and Delete, after "Delete <name>?" (RemoveConfirmRow, the page's one
 * way of asking: Cancel focused, Escape is Cancel, no timer; 2026-11-04 review: an
 * armed "Confirm delete" turned back by itself after 3 s, with no Cancel). The
 * server side is mocked here (a test server keeps no secrets; the real flow is
 * tests/e2e/fleet-secrets-e2e.test.ts). Navigation is by clicks.
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/fleet-secrets'
const NOW = Date.now()
const VALUE = 'test-value-not-a-real-token-1234567890'

type Secret = Record<string, any>

async function openRemoteHosts(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-remote-hosts').click()
  // The group sits under More settings, both closed by default.
  await page.getByTestId('remote-hosts-more-toggle').click()
  await page.getByTestId('fleet-secrets-toggle').click()
  await expect(page.getByTestId('fleet-secrets-toggle')).toHaveAttribute('aria-expanded', 'true')
}

test('secrets: add with hosts and env, the value never shown again, rotate, untick, delete', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let secrets: Secret[] = [{
    name: 'npm-publish', description: 'npm, publish the package', hosts: ['devbox', 'buildbox'], env: 'NPM_TOKEN', sessions: true, version: 3,
    createdAt: NOW - 86_400_000, updatedAt: NOW - 3_600_000,
    copies: { devbox: { version: 3, at: NOW - 3_600_000 }, buildbox: { version: 2, at: NOW - 7_200_000, error: 'the host did not answer' } },
  }]
  const puts: Array<{ name: string; body: Record<string, unknown> }> = []
  const deletes: string[] = []
  await page.route('**/api/v1/secrets', (route) => route.fulfill({ json: { active: true, secrets } }))
  await page.route('**/api/v1/secrets/*', (route) => {
    const name = decodeURIComponent(route.request().url().split('/').pop()!)
    if (route.request().method() === 'DELETE') {
      deletes.push(name)
      secrets = secrets.filter((s) => s.name !== name)
      return route.fulfill({ json: { name, pending: [] } })
    }
    const body = route.request().postDataJSON() as Record<string, any>
    puts.push({ name, body })
    const prev = secrets.find((s) => s.name === name)
    const version = (prev?.version ?? 0) + (body.value ? 1 : 0)
    const hosts: string[] = body.hosts ?? prev?.hosts ?? []
    const next: Secret = {
      name, description: body.description, hosts, env: body.env ?? undefined, sessions: body.sessions, version,
      createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
      copies: Object.fromEntries([...new Set([...hosts, ...Object.keys(prev?.copies ?? {})])].map((h) => [h, { version: hosts.includes(h) ? version : null, at: Date.now() }])),
    }
    secrets = [...secrets.filter((s) => s.name !== name), next].sort((a, b) => a.name.localeCompare(b.name))
    return route.fulfill({ json: { secret: next } })
  })
  await openRemoteHosts(page)
  const group = page.getByTestId('fleet-secrets')
  await expect(group).toBeVisible({ timeout: 30_000 })
  const row = (name: string) => group.locator(`[data-secret-name="${name}"]`)
  await expect(row('npm-publish')).toContainText('npm-publish: npm, publish the package')
  await expect(row('npm-publish')).toContainText('devbox: copied')
  await expect(row('npm-publish')).toContainText('buildbox: not copied yet (the host did not answer)')
  await expect(row('npm-publish')).toContainText('sessions there get $NPM_TOKEN')

  // Add one.
  await group.getByTestId('secret-add').click()
  const editor = group.getByTestId('secret-editor')
  await editor.getByTestId('secret-name').fill('github-read')
  await editor.getByTestId('secret-value').fill(VALUE)
  await editor.getByTestId('secret-description').fill('GitHub, read only')
  await editor.getByTestId('secret-host-__local__').check()
  await editor.getByTestId('secret-env').fill('gh_token')
  await expect(editor.getByTestId('secret-env')).toHaveValue('GH_TOKEN')
  await editor.getByTestId('secret-sessions').check()
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await group.screenshot({ path: `${SHOTS}/${engine}-1-add.png`, scale: 'css' })
  await editor.getByTestId('secret-save').click()
  await expect(editor).toHaveCount(0)
  expect(puts.at(-1)).toEqual({ name: 'github-read', body: { hosts: ['__local__'], env: 'GH_TOKEN', sessions: true, description: 'GitHub, read only', value: VALUE, create: true } })
  await expect(row('github-read')).toContainText('This Mac: copied')
  // The value went up once and is nowhere on the page now.
  expect(await page.content()).not.toContain(VALUE)

  // Edit: the value shows only as saved; Replace rotates it.
  await row('github-read').getByRole('button', { name: 'Edit github-read' }).click()
  await expect(editor.getByTestId('secret-value-saved')).toContainText('Saved in secrets')
  await editor.getByTestId('secret-value-saved').getByRole('button', { name: 'Replace' }).click()
  await editor.getByTestId('secret-value').fill('rotated-test-value-0987654321')
  await editor.getByTestId('secret-save').click()
  await expect(editor).toHaveCount(0)
  expect(puts.at(-1)!.body.value).toBe('rotated-test-value-0987654321')
  expect(secrets.find((s) => s.name === 'github-read')!.version).toBe(2)

  // Edit: untick the host, no new value: the PUT carries no value.
  await row('github-read').getByRole('button', { name: 'Edit github-read' }).click()
  await editor.getByTestId('secret-host-__local__').uncheck()
  await editor.getByTestId('secret-save').click()
  await expect(editor).toHaveCount(0)
  expect(puts.at(-1)!.body).not.toHaveProperty('value')
  expect(puts.at(-1)!.body.hosts).toEqual([])
  await expect(row('github-read')).toContainText('Kept on this Mac only')

  // A bad name is caught before any request, said under the Name field, which takes the focus.
  const before = puts.length
  await group.getByTestId('secret-add').click()
  const name = editor.getByTestId('secret-name')
  await name.fill('Bad Name')
  await editor.getByTestId('secret-value').fill('x')
  await editor.getByTestId('secret-save').click()
  // The reason is the Name row's own error line, right under it.
  const nameError = name.locator('xpath=ancestor::article[1]/following-sibling::*[1]')
  await expect(nameError).toHaveClass(/settings-row-error/)
  await expect(nameError).toContainText('A name is lower case letters')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toBeFocused()
  expect(puts.length).toBe(before)
  // Escape is Cancel: the editor and its refusal go, the focus goes back to Add.
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(group).not.toContainText('A name is lower case letters')
  await expect(group.getByTestId('secret-add')).toBeFocused()
  // Cancel does the same.
  await group.getByTestId('secret-add').click()
  await editor.getByTestId('secret-cancel').click()
  await expect(editor).toHaveCount(0)
  await expect(group.getByTestId('secret-add')).toBeFocused()
  expect(puts.length).toBe(before)

  // Delete asks first ("Delete npm-publish?", Cancel focused); Escape is Cancel and nothing is
  // sent, and nothing turns back on a timer.
  const del = row('npm-publish').getByRole('button', { name: 'Delete npm-publish' })
  await del.click()
  const ask = group.getByTestId('secret-delete-confirm')
  await expect(ask).toContainText('Delete npm-publish?')
  await expect(ask).toContainText('Its copy on every host is removed too.')
  await expect(ask.getByTestId('secret-delete-confirm-cancel')).toBeFocused()
  await expect(ask.getByTestId('secret-delete-confirm-remove')).toHaveText('Delete')
  await page.waitForTimeout(3_300)
  await expect(ask).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
  await expect(del).toBeFocused()
  expect(deletes).toEqual([])
  // Asked again and answered: it sends the DELETE.
  await del.click()
  await ask.getByTestId('secret-delete-confirm-remove').click()
  await expect(row('npm-publish')).toHaveCount(0)
  await expect(ask).toHaveCount(0)
  expect(deletes).toEqual(['npm-publish'])
  for (const r of await group.locator('[data-secret-name]').all()) {
    expect(await r.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  }
  await group.screenshot({ path: `${SHOTS}/${engine}-2-after.png`, scale: 'css' })
  expect(errors).toEqual([])
})
