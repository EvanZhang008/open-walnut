/**
 * Settings saves never lose or undo a value (review findings on the redesign):
 *   - picking a Bedrock credential method only shows its fields; it writes
 *     nothing, so it can't delete the saved token
 *   - a Bedrock region pick saves even when the credentials are not in config,
 *     and keeps the saved token
 *   - a Voice draft still unsaved when the pane closes is saved, not dropped
 *   - clearing a remote host's alias to retype it never deletes the host
 *   - S3 Backup can be filled in while scheduled backups are off
 *
 * The config is served by a stateful mock that behaves like the server
 * (PUT replaces the top-level keys it names), so the shared fixture config
 * never changes under another spec. Both engines: `PW_WEBKIT=1 --project=webkit`.
 */
import { test, expect, type Page } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

type Cfg = Record<string, unknown>

/** Serve /api/config from memory: the real fixture config, patched once. */
async function mockConfigServer(page: Page, patch: (cfg: Cfg) => void) {
  let state: Cfg | null = null
  const puts: Cfg[] = []
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    const req = route.request()
    if (!state) {
      const res = await route.fetch({ method: 'GET' })
      state = ((await res.json()) as { config: Cfg }).config
      patch(state)
    }
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as Cfg
      puts.push(body)
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete state[k]
        else state[k] = v
      }
      return route.fulfill({ status: 200, json: { ok: true } })
    }
    if (req.method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, json: { config: state } })
  })
  return { puts, state: () => state as Cfg }
}

async function openSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(`settings-nav-${id}`)
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 20_000 })
}

const bedrockOf = (cfg: Cfg) => ((cfg.providers as Cfg | undefined)?.bedrock ?? {}) as Cfg

test('a Bedrock credential method pick writes nothing; a region pick keeps the saved token', async ({ page }) => {
  const server = await mockConfigServer(page, (cfg) => {
    cfg.agent = { ...(cfg.agent as Cfg), main_provider: 'bedrock' }
    cfg.providers = { ...(cfg.providers as Cfg), bedrock: { api: 'bedrock', region: 'us-west-2', bearer_token: 'tok-demo' } }
  })
  await openSettings(page)
  await clickNav(page, 'advanced')
  const method = page.getByTestId('bedrock-method-row')
  await expect(method).toBeVisible({ timeout: 20_000 })

  // Look at every other method, then come back: nothing is written.
  for (const m of ['profile', 'keys', 'export', 'token']) await page.getByTestId(`bedrock-method-${m}`).click()
  await page.waitForTimeout(1_500)
  expect(server.puts).toEqual([])
  expect(bedrockOf(server.state()).bearer_token).toBe('tok-demo')

  // A region pick on another method's view still saves, token kept.
  await page.getByTestId('bedrock-method-keys').click()
  await page.locator('#bedrock-region').selectOption('us-east-1')
  await expect.poll(() => bedrockOf(server.state()).region, { timeout: 10_000 }).toBe('us-east-1')
  expect(bedrockOf(server.state()).bearer_token).toBe('tok-demo')
  expect(server.puts).toHaveLength(1)
})

test('a Voice draft is saved when the pane closes before Save', async ({ page }) => {
  const server = await mockConfigServer(page, (cfg) => {
    const tools = (cfg.tools as Cfg | undefined) ?? {}
    cfg.tools = { ...tools, tts: { provider: 'say', voice: 'Samantha' } }
  })
  await openSettings(page)
  await clickNav(page, 'stt')
  const voice = page.locator('#tts-voice')
  await expect(voice).toHaveValue('Samantha', { timeout: 20_000 })
  await voice.fill('Alex')
  await clickNav(page, 'tasks')
  await expect.poll(() => ((server.state().tools as Cfg | undefined)?.tts as Cfg | undefined)?.voice, { timeout: 10_000 }).toBe('Alex')

  // And the value is what Voice shows when it opens again.
  await clickNav(page, 'stt')
  await expect(page.locator('#tts-voice')).toHaveValue('Alex', { timeout: 20_000 })
})

test('clearing a remote host alias to retype it renames the host, never deletes it', async ({ page }) => {
  const server = await mockConfigServer(page, (cfg) => {
    cfg.hosts = { devbox: { hostname: 'devbox.example.com', enabled: true } }
  })
  await openSettings(page)
  await clickNav(page, 'remote-hosts')
  const row = page.locator('.rh-host-row[data-host-alias="devbox"]')
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Edit' }).click()
  const alias = page.locator('#rh-alias-0')
  await alias.fill('')
  // Well past the autosave delay: a save now would drop the host.
  await page.waitForTimeout(2_000)
  expect(server.puts).toEqual([])
  expect(Object.keys((server.state().hosts as Cfg) ?? {})).toEqual(['devbox'])

  await alias.fill('buildbox')
  await expect.poll(() => Object.keys((server.state().hosts as Cfg) ?? {}), { timeout: 10_000 }).toEqual(['buildbox'])
  expect(((server.state().hosts as Cfg).buildbox as Cfg).hostname).toBe('devbox.example.com')
})

test('S3 Backup fields can be filled in while scheduled backups are off', async ({ page }) => {
  const server = await mockConfigServer(page, (cfg) => {
    cfg.backup = { enabled: false, bucket: '', region: 'us-west-2', prefix: 'walnut' }
  })
  await openSettings(page)
  await clickNav(page, 'backup')
  await expect(page.locator('#backup-enabled')).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 })
  await page.locator('#backup-bucket').fill('my-walnut-backup')
  await expect.poll(() => (server.state().backup as Cfg).bucket, { timeout: 10_000 }).toBe('my-walnut-backup')
  expect((server.state().backup as Cfg).enabled).toBe(false)
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled()

  // The interval field can be emptied and retyped without snapping back.
  const every = page.locator('#backup-interval')
  await every.fill('')
  await expect(every).toHaveValue('')
  await every.pressSequentially('6')
  await expect(every).toHaveValue('6')
  await expect.poll(() => (server.state().backup as Cfg).interval_hours, { timeout: 10_000 }).toBe(6)
})
