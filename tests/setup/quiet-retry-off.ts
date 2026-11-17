/**
 * A request a test makes fail, fails at once: the web client's quiet retries
 * (web/src/api/background-retry.ts) are off in tests, so a stubbed 500 or a dropped
 * connection reaches the code under test on its first try, as it did before the retries.
 * A test of the retries themselves sets `quietRetryTiming.delaysMs`. Set through a
 * globalThis key read when the module loads, so it holds after vi.resetModules too, and
 * this file imports nothing of the app.
 */
;(globalThis as { [k: symbol]: number[] | undefined })[Symbol.for('open-walnut.quietRetryDelaysMs')] = []
