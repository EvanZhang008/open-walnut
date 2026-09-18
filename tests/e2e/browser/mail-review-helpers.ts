/**
 * Boot and locators shared by the two review specs (Chromium and WebKit).
 *
 * A helpers MODULE rather than an import from a spec file: importing a spec would run its tests in the
 * other engine too, and a `test.use` browser pin only applies at the top level of its own file.
 *
 * The fixture is the DENSE one: two accounts, 64 folders against 6, the same roles under different
 * mailbox ids, six labels holding stale unread and one of them with cached mail. Every defect these
 * specs pin was only visible at that density.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, type Locator, type Page } from '@playwright/test'

export const PANE = '.mail-accounts-pane'
export const HARBOUR = 'dense:harbour'
export const MARINA = 'dense:marina'
/** The one collapsed-tail label with cached mail: 6 messages, 2 of them unread. */
export const TAIL_FOLDER = 'harbour/label/receipts'

export interface MailFixture { port: number, home: string }

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a mail fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

/** One fixture server with a throwaway home. `stop` removes the home it made. */
export class MailFixtureServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private output = ''
  fixture: MailFixture | null = null

  async start(env: Record<string, string> = {}): Promise<MailFixture> {
    const port = await reservePort()
    this.child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PW_MAIL_PORT: String(port),
        PW_MAIL_DENSE: '1',
        PW_MAIL_DIGEST_OFF: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => { this.output = `${this.output}${String(chunk)}`.slice(-20_000) })
    this.child.stderr.on('data', (chunk) => { this.output = `${this.output}${String(chunk)}`.slice(-20_000) })
    this.fixture = await this.ready()
    return this.fixture
  }

  private ready(): Promise<MailFixture> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`Mail fixture did not start\n${this.output.slice(-8000)}`)),
        180_000,
      )
      const timer = setInterval(() => {
        const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(this.output)
        if (match) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve(JSON.parse(match[1]!) as MailFixture)
          return
        }
        if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
          clearInterval(timer)
          clearTimeout(deadline)
          reject(new Error(`Mail fixture exited early (${this.child.exitCode})\n${this.output.slice(-8000)}`))
        }
      }, 250)
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      const deadline = Date.now() + 15_000
      while (this.child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (this.child.exitCode === null) this.child.kill('SIGKILL')
    }
    if (this.fixture?.home.includes('walnut-mail-app-')) {
      await fs.rm(this.fixture.home, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** Into the Mail console through the real UI: the sidebar app row, never a deep link. */
export async function openMail(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.locator(PANE)).toBeVisible({ timeout: 90_000 })
}

export function smartRow(page: Page, role: string): Locator {
  return page.locator(`${PANE} .mail-mailbox.smart[data-smart="${role}"]`)
}

export function twist(page: Page, role: string): Locator {
  return page.locator(`${PANE} .mail-twist[data-smart="${role}"]`)
}

export function tailToggle(page: Page, accountId: string): Locator {
  return page.locator(`${PANE} .mail-tail-toggle[data-account-id="${accountId}"]`)
}

export function accountSection(page: Page, accountId: string): Locator {
  return page.locator(`${PANE} .mail-account[data-account-id="${accountId}"]`)
}

export function folderRow(page: Page, accountId: string, mailboxId: string): Locator {
  return accountSection(page, accountId).locator(`.mail-mailbox[data-mailbox-id="${mailboxId}"]`)
}

/**
 * Wait out this pane's ONE animation before measuring it.
 *
 * The chevron rotates over 120ms, and a rotating box is wider than the box it rotates: a 12px square turned
 * 45deg measures 17px, so its `getBoundingClientRect().left` sits 2.5px LEFT of the 12px glyph column it
 * belongs to. A geometry assertion taken in the frame after a twist was clicked therefore read the mark at
 * 10 or 11 and failed against a product that is correct (measured 12 on all three glyphs in a settled pane).
 * The column is a layout fact, not a frame of a transition. Raced with a deadline so a future animation that
 * never finishes cannot hang the suite.
 */
async function settlePane(page: Page): Promise<void> {
  await page.locator(PANE).evaluate(async (pane) => {
    const done = Promise.all(
      pane.getAnimations({ subtree: true }).map((one) => one.finished.catch(() => undefined)),
    )
    await Promise.race([done, new Promise((wake) => { setTimeout(wake, 500) })])
  })
}

/** How far a row's glyph and its text start from the PANE's own left edge, which is what a person scans. */
export async function paneGeometry(page: Page): Promise<Record<string, number>> {
  await settlePane(page)
  return page.evaluate(() => {
    const pane = document.querySelector('.mail-accounts-pane') as HTMLElement
    const left = pane.getBoundingClientRect().left
    const at = (selector: string, inner: string) => {
      const row = document.querySelector(selector) as HTMLElement | null
      const mark = row?.querySelector(inner) as HTMLElement | null
      return mark ? Math.round(mark.getBoundingClientRect().left - left) : -1
    }
    return {
      smartGlyph: at('.mail-mailbox-line', '.mail-twist svg'),
      smartText: at('.mail-mailbox.smart', '.mail-mailbox-name'),
      childText: at('.mail-mailbox.child', '.mail-mailbox-name'),
      folderGlyph: at('.mail-account .mail-mailbox', 'svg'),
      folderText: at('.mail-account .mail-mailbox', '.mail-mailbox-name'),
      tailGlyph: at('.mail-tail-toggle', '.mail-tail-twist svg'),
      tailText: at('.mail-tail-toggle', '.mail-tail-label'),
    }
  })
}

/** Screenshot into this slice's own directory, and hand back the path for the log. */
export async function shoot(target: Locator | Page, dir: string, name: string): Promise<string> {
  const path = `${dir}/${name}.png`
  await target.screenshot({ path })
  return path
}

/**
 * The collapse row as a person reads it: its two clauses, their type, and whether either is cut off.
 *
 * The clauses are separate flex items with a real GAP rather than a trailing space (a space at the end of
 * an inline box is dropped in layout in both engines), so the gap is measured rather than read.
 */
export async function tailShape(page: Page, accountId: string): Promise<{
  text: string
  label: string
  clause: string
  size: string
  colour: string
  gap: number
  cut: number[]
  height: number
  folderHeight: number
  contrast: number
}> {
  return page.evaluate((account) => {
    const row = document.querySelector(`.mail-tail-toggle[data-account-id="${account}"]`) as HTMLElement
    const label = row.querySelector('.mail-tail-label') as HTMLElement
    const clause = row.querySelector('.mail-tail-unread') as HTMLElement | null
    const folder = document.querySelector('.mail-account .mail-mailbox') as HTMLElement
    const rgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const luminance = (value: string): number => {
      const channels = rgb(value).map((one) => {
        const ratio = one / 255
        return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    const style = getComputedStyle(row)
    const pane = getComputedStyle(document.querySelector('.mail-accounts-pane')!).backgroundColor
    const light = Math.max(luminance(style.color), luminance(pane))
    const dark = Math.min(luminance(style.color), luminance(pane))
    return {
      text: row.textContent?.trim() ?? '',
      label: label.textContent ?? '',
      clause: clause?.textContent ?? '',
      size: style.fontSize,
      colour: style.color,
      gap: clause
        ? Math.round(clause.getBoundingClientRect().left - label.getBoundingClientRect().right)
        : -1,
      cut: [label, clause].filter(Boolean).map((one) => (one as HTMLElement).scrollWidth - (one as HTMLElement).clientWidth),
      height: Math.round(row.getBoundingClientRect().height),
      folderHeight: Math.round(folder.getBoundingClientRect().height),
      contrast: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100,
    }
  }, accountId)
}

/** The expanded tail's filter box and its no-match line, against the folder text column they sit in. */
export async function filterShape(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => {
    const pane = document.querySelector('.mail-accounts-pane') as HTMLElement
    const left = pane.getBoundingClientRect().left
    const input = document.querySelector('.mail-tail-filter') as HTMLElement
    const empty = document.querySelector('.mail-tail-empty') as HTMLElement | null
    const name = document.querySelector('.mail-account .mail-mailbox .mail-mailbox-name') as HTMLElement
    const style = getComputedStyle(input)
    return {
      // Where the TEXT starts, which is the column a person reads down, not where the box starts.
      inputText: Math.round(input.getBoundingClientRect().left - left + Number.parseFloat(style.paddingLeft)),
      folderText: Math.round(name.getBoundingClientRect().left - left),
      inputHeight: Math.round(input.getBoundingClientRect().height),
      rowHeight: Math.round(
        (document.querySelector('.mail-account .mail-mailbox') as HTMLElement).getBoundingClientRect().height,
      ),
      border: style.borderTopWidth,
      emptyText: empty ? Math.round(empty.getBoundingClientRect().left
        + Number.parseFloat(getComputedStyle(empty).paddingLeft) - left) : -1,
    }
  })
}

/** Switch the theme the way the app does: Settings, the picker, back to Mail. */
export async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('sidebar-core-app-mail').click()
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 })
}
