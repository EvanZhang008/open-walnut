import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

interface LogSnapshot {
  sizes: Map<string, number>
}

export interface BrowserFixturePaths {
  fixtureRoot: string
  walnutHome: string
}

export interface AuditAllowances {
  http?: (response: { status: number; method: string; url: string }) => boolean
  requestFailure?: (failure: { method: string; url: string; errorText?: string }) => boolean
  consoleError?: (message: string) => boolean
}

async function logFiles(walnutHome: string): Promise<string[]> {
  const logDir = path.join(walnutHome, 'daemon')
  try {
    return (await fs.readdir(logDir))
      .filter((name) => name.endsWith('.log'))
      .map((name) => path.join(logDir, name))
  } catch {
    return []
  }
}

async function snapshotLogs(walnutHome: string): Promise<LogSnapshot> {
  const sizes = new Map<string, number>()
  for (const file of await logFiles(walnutHome)) {
    sizes.set(file, (await fs.stat(file)).size)
  }
  return { sizes }
}

async function persistedBrowserErrors(
  walnutHome: string,
  snapshot: LogSnapshot,
): Promise<string[]> {
  const errors: string[] = []
  for (const file of await logFiles(walnutHome)) {
    const content = await fs.readFile(file)
    const start = snapshot.sizes.get(file) ?? 0
    for (const line of content.subarray(start).toString('utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as {
          subsystem?: string
          level?: string
          browserLevel?: string
          message?: string
        }
        if (entry.subsystem === 'browser'
          && (entry.level === 'error' || entry.browserLevel === 'error')) {
          errors.push(entry.message ?? line)
        }
      } catch {
        // A concurrent append can leave the final line incomplete until the next flush.
      }
    }
  }
  return errors
}

function isExpectedNavigationAbort(message: string): boolean {
  return /^\[api\] GET \/api\/sessions\/[^ ]+\/history\?\S* → (?:200|304) JSON parse failed in \d+ms(?: AbortError: The user aborted a request\.)?$/
    .test(message)
}

/**
 * The ps-fixture config declares a remote host (`fixture-remote`) whose
 * hostname never resolves, and the fixture server runs EPHEMERAL (attach-only:
 * it refuses to deploy/start remote daemons). Opening the folder picker fires
 * the background SSH pre-warm (`prewarmWorkingDirs`), whose remote-host
 * list-dirs therefore answers 400. That is by-design fixture noise — the
 * pre-warm is fire-and-forget, the UI renders the host as "not responding" —
 * not a product bug, so both the api-client console line and Chromium's
 * generic "Failed to load resource" (matched via its resource URL) are
 * excluded from the audit. Local list-dirs failures still fail the audit:
 * the allowance requires a `host=` param on the URL.
 */
function isFixtureRemoteListDirs400(text: string, resourceUrl: string): boolean {
  const remoteListDirs = (u: string) => u.includes('/api/sessions/list-dirs') && u.includes('host=')
  if (/^\[api\] GET \/api\/sessions\/list-dirs\?\S*host=\S* → 400 /.test(text)) return true
  return /^Failed to load resource: the server responded with a status of 400/.test(text)
    && remoteListDirs(resourceUrl)
}

/**
 * The homepage search box drives the AI task-search lane (`GET
 * /api/search/agent`), which answers 503 `ai_disabled` in every fixture that
 * has no AI credentials (all of them). The api-client logs that expected 503 as
 * a warn (quietStatuses), but Chromium still emits its own generic "Failed to
 * load resource … 503" console.error, matched here via the resource URL — the
 * same shape as the remote-list-dirs allowance above. Scoped to that exact
 * endpoint + status, so a real 503 elsewhere still fails the audit.
 */
function isFixtureAiSearchDisabled503(text: string, resourceUrl: string): boolean {
  const aiSearch = (u: string) => u.includes('/api/search/agent')
  if (/^\[api\] GET \/api\/search\/agent\?\S* → 503 /.test(text)) return true
  return /^Failed to load resource: the server responded with a status of 503/.test(text)
    && aiSearch(resourceUrl)
}

/**
 * Any session that renders the mode pill probes GET /api/sessions/:id/plan for
 * existing plan content; a session that never entered plan mode answers 404
 * "No plan content found for this session". That is the normal cold state, not
 * a product bug. It matters here because the persisted-log check reads the ONE
 * shared daemon log by byte offset, so a sibling spec's session (every browser
 * spec forwards into the same file) can drop this benign line inside another
 * spec's audit window — which is why it surfaces racily. Scoped to that exact
 * endpoint + status + message so a real /plan failure still fails the audit.
 */
function isBenignPlanProbe404(text: string, resourceUrl: string): boolean {
  const planProbe = (u: string) => /\/api\/sessions\/[^/]+\/plan(?:\?|$)/.test(u)
  if (/^\[api\] GET \/api\/sessions\/[^ ]+\/plan → 404 .*: No plan content found for this session$/.test(text)) {
    return true
  }
  return /^Failed to load resource: the server responded with a status of 404/.test(text)
    && planProbe(resourceUrl)
}

export async function discoverBrowserFixture(testPort: number): Promise<BrowserFixturePaths> {
  const response = await fetch(`http://localhost:${testPort}/api/sessions/working-dirs`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { dirs: Array<{ cwd: string }> }
  const walnut = body.dirs.find((dir) => /\/ps-fixture\/projects\/walnut$/.test(dir.cwd))
  if (!walnut) throw new Error('ps-fixture/projects/walnut seed missing from working-dirs')
  return {
    fixtureRoot: walnut.cwd.replace(/\/projects\/walnut$/, ''),
    walnutHome: walnut.cwd.replace(/\/ps-fixture\/projects\/walnut$/, ''),
  }
}

export async function installBrowserAudit(page: Page, walnutHome: string): Promise<{
  assertClean(allowances?: AuditAllowances): Promise<void>
}> {
  const baseline = await snapshotLogs(walnutHome)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: Array<{ method: string; url: string; errorText?: string }> = []
  const httpErrors: Array<{ status: number; method: string; url: string }> = []

  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // location().url identifies the RESOURCE for Chromium's generic network
    // console errors — needed to attribute "Failed to load resource" lines.
    if (isFixtureRemoteListDirs400(message.text(), message.location().url ?? '')) return
    if (isFixtureAiSearchDisabled503(message.text(), message.location().url ?? '')) return
    if (isBenignPlanProbe404(message.text(), message.location().url ?? '')) return
    consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (request) => {
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText,
    })
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    // Same fixture allowance as the console filter: the dead remote host's
    // list-dirs pre-warm answers 400 on the attach-only ephemeral server.
    if (response.status() === 400
      && response.url().includes('/api/sessions/list-dirs')
      && response.url().includes('host=')) return
    // Expected fixture 503: the AI task-search lane with no AI credentials.
    if (response.status() === 503 && response.url().includes('/api/search/agent')) return
    // Expected 404: the mode pill's plan-content probe on a session with no plan.
    if (response.status() === 404
      && response.request().method() === 'GET'
      && /\/api\/sessions\/[^/]+\/plan(?:\?|$)/.test(response.url())) return
    httpErrors.push({
      status: response.status(),
      method: response.request().method(),
      url: response.url(),
    })
  })

  return {
    async assertClean(allowances = {}) {
      const standardAbort = (failure: { method: string; url: string; errorText?: string }) => {
        const pathname = new URL(failure.url).pathname
        if (failure.errorText !== 'net::ERR_ABORTED') return false
        return (failure.method === 'GET'
            && (pathname.endsWith('/workflow')
              || pathname.endsWith('/history')
              || pathname === '/api/notifications'))
          || (failure.method === 'POST' && pathname === '/api/browser-logs')
      }
      const unexpectedFailures = failedRequests.filter((failure) =>
        !standardAbort(failure) && !allowances.requestFailure?.(failure))
      const unexpectedHttp = httpErrors.filter((response) => !allowances.http?.(response))

      // Browser logger flushes every two seconds over the real WebSocket route.
      await page.waitForTimeout(2_200)
      expect(
        consoleErrors.filter((message) =>
          !isExpectedNavigationAbort(message) && !allowances.consoleError?.(message)),
        'console.error output',
      ).toEqual([])
      expect(pageErrors, 'uncaught page errors').toEqual([])
      expect(unexpectedFailures, 'failed browser requests').toEqual([])
      expect(unexpectedHttp, 'HTTP error responses').toEqual([])
      expect(
        (await persistedBrowserErrors(walnutHome, baseline))
          .filter((message) =>
            !isExpectedNavigationAbort(message)
            // The api-client's list-dirs 400 console.error is forwarded to the
            // server log too — same fixture allowance (no resource URL here;
            // the `[api]`-line regex carries the host= discriminator itself).
            && !isFixtureRemoteListDirs400(message, '')
            // Same for the AI-search 503 `[api]` line forwarded to the server log.
            && !isFixtureAiSearchDisabled503(message, '')
            // The mode pill's cold-session plan probe 404 (a sibling spec's
            // session can land it inside this window — shared daemon log).
            && !isBenignPlanProbe404(message, '')
            && !allowances.consoleError?.(message)),
        'persisted browser error logs',
      ).toEqual([])
    },
  }
}
