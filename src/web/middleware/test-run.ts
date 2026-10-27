/**
 * Puts a request that says it is a test run (`x-walnut-test-run`) in the test-run scope, so
 * every task and project it creates is a test object (src/core/test-run.ts). Decided once at
 * boot: a throwaway server ignores the header.
 */
import type { RequestHandler } from 'express'
import { TEST_RUN_HEADER, parseTestRunLabel, testRunMarkingEnabled, withTestRun } from '../../core/test-run.js'

export async function testRunMiddleware(): Promise<RequestHandler> {
  const on = await testRunMarkingEnabled()
  return (req, res, next) => {
    const label = on ? parseTestRunLabel(req.headers[TEST_RUN_HEADER]) : undefined
    if (!label) { next(); return }
    // Only while the request is open: work it leaves armed (a timer) is not the test run's.
    let open = true
    const end = () => { open = false }
    res.once('finish', end)
    res.once('close', end)
    withTestRun(label, () => next(), () => open)
  }
}
