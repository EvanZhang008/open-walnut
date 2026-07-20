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
    if (message.type() === 'error') consoleErrors.push(message.text())
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
    if (response.status() >= 400) {
      httpErrors.push({
        status: response.status(),
        method: response.request().method(),
        url: response.url(),
      })
    }
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
            !isExpectedNavigationAbort(message) && !allowances.consoleError?.(message)),
        'persisted browser error logs',
      ).toEqual([])
    },
  }
}
