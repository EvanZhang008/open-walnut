/**
 * Run by tests/binary/service-entry.test.ts: runHostService with the decision in argv[2], as
 * main.ts calls it after decideServiceEntry said `serve`. The test makes only the path that ends
 * before the server loads reachable (a daemon holds the runtime dir); a runtime load throws.
 * MACHINE SAFETY: the test's temp dirs only (the decision names them).
 */
const { runHostService } = await import('../../../src/binary/service-entry.ts')
await runHostService(JSON.parse(process.argv[2]!), async () => { throw new Error('this fixture carries no runtime') })
