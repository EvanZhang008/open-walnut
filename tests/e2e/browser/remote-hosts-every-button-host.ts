/**
 * A host's own settings in remote-hosts-every-button.spec.ts: "This host" in its Details
 * (HostThisPart.tsx). 2026-11-04 review: one host's settings sat in four groups under More
 * settings, away from the host, and two buttons named "Retry" meant different things. Alpha box:
 * its session limit, the tasks from other hosts (its switch, a Revoke), Walnut on it (its address,
 * what it keeps, its tunnel, Update to this build) and the secrets copied to it. Beta box: Walnut
 * on it switched off and on, Restart tunnel, and a declined task allowed.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type Locator } from '@playwright/test'
import { ALPHA_URL, expectCopied, expectOpensTab, flip } from './remote-hosts-every-button-helpers'
import type { StepCtx } from './remote-hosts-every-button-steps'

/** Each PUT a switch sends to `path`, read with `take`, is `want(on)`. */
function saw(ctx: StepCtx, path: string, take: (b: Record<string, unknown>) => unknown, want: (on: boolean) => unknown, also?: (on: boolean) => Promise<void>) {
  const base = ctx.routes.callsTo('PUT', path).length
  let k = 0
  return async (on: boolean) => {
    expect(take((await ctx.routes.nth('PUT', path, base + ++k)).body as Record<string, unknown>)).toEqual(want(on))
    await also?.(on)
  }
}

export async function checkAlphaThisHost(ctx: StepCtx, details: Locator): Promise<void> {
  const { routes, ran } = ctx
  const part = details.getByTestId('rh-this-host-devbox')
  await expect(part.locator('.rh-this-host-heading')).toHaveText('This host')

  // Its session limit, saved with the hosts; empty is the default, said in the box.
  const limit = part.locator('#rh-limit-devbox')
  await expect(limit).toHaveValue('3')
  const puts = routes.callsTo('PUT', '/api/config').length
  const limits = async (n: number) => ((await routes.nth('PUT', '/api/config', puts + n)).body as { session_limits: unknown }).session_limits
  await limit.fill('4')
  expect(await limits(1)).toEqual({ devbox: 4 })
  await limit.fill('')
  expect(await limits(2)).toEqual({})
  await expect(limit).toHaveAttribute('placeholder', '20')
  await limit.fill('3')
  expect(await limits(3)).toEqual({ devbox: 3 })

  // Tasks on other hosts may use it: only Off explains itself.
  const exec = part.getByTestId('rh-host-exec')
  await flip(part.getByRole('switch', { name: 'Tasks on other hosts may use Alpha box' }), saw(ctx, '/api/v1/host-exec/hosts/devbox', (b) => b, (on) => ({ closed: !on }), async (on) => {
    if (on) await expect(exec).not.toContainText('Off:')
    else await expect(exec).toContainText('Off: nothing new starts here from another host.')
  }))
  ran('Hosts/switch#rh-host-exec-switch-<host>')
  // A grant's line names no host: it is this host's part.
  const grant = part.locator('[data-grant-id="g-1"]')
  await expect(grant).toContainText(/Allowed .*; 3 uses, last .*: make test/)
  await expect(grant).not.toContainText('Alpha box')
  await part.getByRole('button', { name: 'Revoke Nightly build on Alpha box' }).click()
  await routes.nth('DELETE', '/api/v1/host-exec/grants/g-1', 1)
  await expect(grant).toHaveCount(0)
  await expect(part).toContainText('No task from another host has used it yet.')
  ran('Hosts/button:Revoke <task> on <host>')

  // Walnut on this host: its address, what it keeps (one line until opened), its tunnel.
  await expect(part.getByTestId('host-server-devbox')).toContainText('Walnut on this host')
  await expectOpensTab(ctx.page, part.getByTestId('host-server-url-devbox'), ALPHA_URL)
  await expectCopied(ctx.page, part.getByTestId('host-server-copy-url-devbox'), ALPHA_URL)
  ran('Hosts/link#host-server-url-<host>', 'Hosts/button#host-server-copy-url-<host>')
  const kept = part.getByTestId('host-server-copies-toggle-devbox')
  await expect(kept).toContainText('Kept on this host')
  await expect(kept).toContainText('All 11 kinds copied')
  const copies = part.locator('[data-testid^="host-server-copy-devbox-"][role="switch"]')
  await expect(copies.first()).toBeHidden()
  await kept.click()
  await expect(kept).toHaveAttribute('aria-expanded', 'true')
  await expect(copies).toHaveCount(11)
  for (const sw of await copies.all()) await expect(sw).toBeVisible()
  await ctx.sweep()
  for (const id of await copies.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))) {
    const kind = id.replace('host-server-copy-devbox-', '')
    // The line counts the switches that are on (one off can take a kind riding with it along).
    await flip(part.getByTestId(id), saw(ctx, '/api/host-servers/devbox', (b) => (b.copies as Record<string, boolean>)[kind], (on) => on, async () => {
      await expect.poll(async () => {
        const n = await copies.evaluateAll((els) => els.filter((el) => el.getAttribute('aria-checked') === 'true').length)
        const text = (await kept.textContent()) ?? ''
        return text.includes(n === 11 ? 'All 11 kinds copied' : `${n} of 11 copied`)
      }).toBe(true)
    }))
  }
  await kept.click()
  await expect(copies.first()).toBeHidden()
  ran('Hosts/button#host-server-copies-toggle-<host>', 'Hosts/switch#host-server-copy-<host>-<kind>')
  await flip(part.getByTestId('host-server-expose-devbox'), saw(ctx, '/api/host-servers/devbox', (b) => (b.expose as { enabled: boolean }).enabled, (on) => on))
  ran('Hosts/switch#host-server-expose-<host>')
  // A running Walnut on an older build: Update to this build, busy, then the new build starting;
  // the row's line that sent here goes with it (one count on the page).
  const alphaRow = ctx.page.locator('[data-testid="remote-hosts-list"] .rh-host-row[data-host-alias="devbox"]')
  await expect(alphaRow.getByTestId('rh-row-settings-look')).toHaveText('Walnut on this host needs a look: see Details.')
  const retry = part.getByTestId('host-server-retry-devbox')
  await expect(retry).toHaveText('Update to this build')
  // A switch's write on the same host leaves the button's words alone, and holds its press
  // (review: a "Kept on this host" switch made it read Updating...).
  const expose = part.getByTestId('host-server-expose-devbox')
  const writing = routes.gate('host-server')
  await expose.click()
  await expect(expose).toHaveAttribute('aria-busy', 'true')
  await expect(retry).toHaveText('Update to this build')
  await expect(retry).toHaveAttribute('aria-disabled', 'true')
  writing()
  await expect(expose).not.toHaveAttribute('aria-busy', 'true')
  await expect(retry).not.toHaveAttribute('aria-disabled', 'true')
  const n = routes.callsTo('PUT', '/api/host-servers/devbox').length
  await expose.click()
  await routes.nth('PUT', '/api/host-servers/devbox', n + 1)
  await expect(expose).not.toHaveAttribute('aria-busy', 'true')
  const release = routes.gate('host-server')
  await retry.click()
  await expect(retry).toHaveText('Updating...')
  await expect(part.getByTestId('host-server-enabled-devbox')).toHaveAttribute('aria-busy', 'true')
  release()
  await expect(part.getByTestId('host-server-state-devbox')).toHaveText('Starting the new build...')
  await expect(retry).toHaveCount(0)
  await expect(alphaRow.getByTestId('rh-row-settings-look')).toHaveCount(0)
  ran('Hosts/button#host-server-retry-<host>')

  // The secrets copied here, each with its own switch.
  const copy = part.locator('[data-secret-copy="github-read"]')
  await expect(copy).toContainText('Copied here.')
  await flip(part.getByRole('switch', { name: 'Copy github-read to Alpha box' }), saw(ctx, '/api/v1/secrets/github-read', (b) => b.hosts, (on) => (on ? ['devbox'] : []), async (on) => {
    await expect(copy).toContainText(on ? 'Copied here.' : 'Removing it here...')
  }))
  ran('Hosts/switch#rh-secret-copy-<secret>-<host>')
}

export async function checkBetaThisHost(ctx: StepCtx, details: Locator): Promise<void> {
  const { routes, ran } = ctx
  const part = details.getByTestId('rh-this-host-downbox')
  await expect(part.locator('#rh-limit-downbox')).toHaveValue('')
  await flip(part.getByTestId('host-server-enabled-downbox'), saw(ctx, '/api/host-servers/downbox', (b) => b.enabled, (on) => on))
  ran('Hosts/switch#host-server-enabled-<host>')
  // Its tunnel's retry says what it does (2026-11-04 review: "Retry", like the row's SSH one).
  const tunnelRetry = part.getByTestId('host-server-tunnel-retry-downbox')
  await expect(tunnelRetry).toHaveText('Restart tunnel')
  await tunnelRetry.click()
  await expect(part.getByTestId('host-server-tunnel-state-downbox')).toHaveText('Starting Test tunnel...')
  expect(routes.callsTo('POST', '/api/host-servers/downbox/expose/retry')).toHaveLength(1)
  ran('Hosts/button#host-server-tunnel-retry-<host>')
  // A task you declined here: Allow makes it a grant, with its Revoke.
  await ctx.sweep()
  await part.getByRole('button', { name: 'Allow Lint job on Beta box' }).click()
  expect((await routes.nth('POST', '/api/v1/host-exec/grants', 1)).body).toEqual({ task_id: 'task-lint', host: 'downbox' })
  await expect(part.locator('[data-denied]')).toHaveCount(0)
  await expect(part.getByRole('button', { name: 'Revoke Lint job on Beta box' })).toBeVisible()
  ran('Hosts/button:Allow <task> on <host>')
  await ctx.sweep()
}
