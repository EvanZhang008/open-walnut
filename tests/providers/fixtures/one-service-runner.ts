/**
 * Run by tests/providers/one-service-host-e2e.test.ts with bun, as the launcher runs `<exe> --service`:
 * the same two calls src/binary/main.ts makes (the compiled file's entry cannot run from source).
 * Prints `daemon <why>` and exits 3 when the entry answers daemon.
 * MACHINE SAFETY: the test's temp dirs only (its env names them).
 */
const { decideServiceEntry, runHostService } = await import('../../../src/binary/service-entry.ts')
const decision = decideServiceEntry(process.env, process.execPath)
if (decision.kind !== 'serve') {
  console.log(`daemon ${decision.why}`)
  process.exit(3)
}
await runHostService(decision, () => import('../../../src/providers/daemon-standalone.ts'))
