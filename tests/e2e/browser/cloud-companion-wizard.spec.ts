/**
 * Settings → Cloud Companion wizard.
 *
 * Scope on purpose: everything up to and including a REAL job running through the
 * real state machine, then cancel. It does NOT try to reach 'done' — the last
 * steps poll a real box over HTTP and claim it with a real token, which no
 * browser fixture can honestly fake. That end-to-end path is covered by the PR2
 * integration test against a second Walnut booted in cloud mode.
 *
 * The fixture registers a fake provisioning driver (WALNUT_CLOUD_SETUP_FAKE=1 in
 * test-server.ts) whose createVM parks forever, so the job predictably sits on
 * `provision` and the spec can assert the UI's cancel path for real.
 *
 * Serial: the setup job is a server-side SINGLETON, so these tests must not
 * interleave with each other.
 */
import { test, expect, type Page } from '@playwright/test'

const FAKE_PROVIDER = 'Fake provider (test fixture)'

test.describe.configure({ mode: 'serial' })

/** Real-user navigation into the Cloud Companion section (no page.goto). */
async function openCloudSection(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

  const nav = page.locator('.settings-nav-item', { hasText: /^Cloud Companion$/ })
  await expect(nav).toHaveCount(1)
  await nav.click()

  const section = page.locator('#cloud')
  await expect(section).toBeVisible()
  return section
}

/** Leave no job behind — the next test (and a re-run) starts from the hero. */
async function clearAnyJob(page: Page) {
  await page.evaluate(async () => {
    await fetch('/api/cloud-setup/job/cancel', { method: 'POST' }).catch(() => {})
    await fetch('/api/cloud-setup/job', { method: 'DELETE' }).catch(() => {})
  })
}

test.describe('Settings → Cloud Companion', () => {
  test.afterEach(async ({ page }) => {
    await clearAnyJob(page)
  })

  test('hero → provider cards from the live probe → configure validation', async ({ page }) => {
    const section = await openCloudSection(page)

    // Nothing configured in the fixture, so the entry point is the hero — including
    // the hint that the butler can do this too (the plan's discoverability promise).
    // Generous timeout: the mount probe (GET /job + GET /api/devices) must finish
    // first, and under heavy machine load that easily outlives the default 5s.
    await expect(section.getByRole('heading', { name: /Set up your own cloud companion/i })).toBeVisible({ timeout: 60_000 })
    await expect(section).toContainText(/ask your butler/i)

    await section.getByRole('button', { name: /Get started/i }).click()

    // Cards come from GET /providers. The aws probe's verdict depends on the host's
    // credentials, so assert PRESENCE (and that a pill rendered at all), never readiness.
    const cards = section.locator('.cloud-provider-card')
    await expect(cards.first()).toBeVisible({ timeout: 60_000 })
    await expect(section.locator('.cloud-provider-card[data-provider="aws"]')).toHaveCount(1)
    await expect(section.locator('.cloud-provider-card[data-provider="manual"]')).toHaveCount(1)
    await expect(section.locator('.cloud-provider-card[data-provider="aws"] .cloud-pill')).toHaveCount(1)

    // Own-domain is the default and REQUIRES a domain — the start button must stay
    // disabled until one is typed (client-side guard for the route's 400).
    await section.locator('.cloud-provider-card[data-provider="aws"]').click()
    const startBtn = section.getByRole('button', { name: /^Start setup$/ })
    await expect(startBtn).toBeDisabled()
    await expect(section).toContainText(/Enter a domain, or switch to the free auto-address/i)

    // Role-scoped: the radio labels also contain the word "Domain".
    await section.getByRole('textbox', { name: 'Domain' }).fill('walnut.example.com')
    await expect(startBtn).toBeEnabled()

    // Switching to the free auto-address drops the requirement entirely.
    await section.getByRole('button', { name: /^Back$/ }).click()
    await section.locator('.cloud-provider-card[data-provider="manual"]').click()
    await expect(section.getByRole('button', { name: /Generate the script/i })).toBeEnabled()
  })

  test('manual path shows a copyable boot script carrying the setup-token write', async ({ page }) => {
    const section = await openCloudSection(page)
    await section.getByRole('button', { name: /Get started/i }).click()
    await section.locator('.cloud-provider-card[data-provider="manual"]').click()

    // A manual driver defaults to sslip (no registrar), so this starts immediately.
    await section.getByRole('button', { name: /Generate the script/i }).click()

    // The job parks asking for the VM's IP, which is what surfaces the paste panel.
    const blob = section.locator('.cloud-userdata-box')
    await expect(blob).toBeVisible({ timeout: 60_000 })

    const script = await blob.inputValue()
    // THE contract of this screen: the blob is the real first-boot script, and the
    // pairing code reaches the box by being written to /etc/walnut/setup-token.
    expect(script).toContain('/etc/walnut/setup-token')
    expect(script).toContain('scripts/cloud/setup.sh')
    expect(script).toContain('sslip.io')
    // Copy affordance exists (clipboard permissions vary in CI, so assert the
    // control, not the OS clipboard).
    await expect(section.getByRole('button', { name: /Copy script/i })).toBeVisible()

    // The IP prompt is the single place to type it — offered by the step list.
    await expect(section.getByRole('textbox', { name: 'VM public IPv4 address' })).toBeVisible()
  })

  test('start → job runs to provision → cancel from the UI → start over clears it', async ({ page }) => {
    const section = await openCloudSection(page)
    await section.getByRole('button', { name: /Get started/i }).click()

    const fakeCard = section.locator('.cloud-provider-card', { hasText: FAKE_PROVIDER })
    await expect(fakeCard).toHaveCount(1, { timeout: 60_000 })
    await fakeCard.click()

    // sslip so there is no DNS step to wait on before provision.
    await section.getByRole('radio', { name: /Free auto-address/i }).check()
    await section.getByRole('button', { name: /^Start setup$/ }).click()

    // The checklist appears and the earlier steps complete for real (preflight
    // validates this machine, generate builds+validates the boot script).
    const steps = section.locator('.cloud-steps')
    await expect(steps).toBeVisible({ timeout: 60_000 })
    await expect(steps.locator('.cloud-step[data-step="preflight"]')).toHaveClass(/cloud-step-done/, { timeout: 30_000 })
    await expect(steps.locator('.cloud-step[data-step="generate"]')).toHaveClass(/cloud-step-done/, { timeout: 30_000 })
    // …and the job parks on provision, where the fake driver never returns.
    await expect(steps.locator('.cloud-step[data-step="provision"]')).toHaveClass(/cloud-step-running/, { timeout: 30_000 })

    // Progress log lines arrived over SSE (the stream, not a poll) — preflight
    // logs the provider it resolved.
    await section.locator('.cloud-log > summary').click()
    await expect(section.locator('.cloud-log-body')).toContainText(/Fake provider/i, { timeout: 30_000 })

    await section.getByRole('button', { name: /Cancel setup/i }).click()
    await expect(section).toContainText(/Setup was cancelled/i, { timeout: 30_000 })

    // Start over deletes the record and returns to the hero.
    await section.getByRole('button', { name: /Start over/i }).click()
    await expect(section.getByRole('heading', { name: /Set up your own cloud companion/i })).toBeVisible({ timeout: 30_000 })
  })
})
