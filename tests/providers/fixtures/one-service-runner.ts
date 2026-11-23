/**
 * The launcher's `<exe> --service` with bun, from source: the same calls src/binary/main.ts makes
 * (the compiled file's entry cannot run from source): the start hooks and the decision
 * (service-start-hooks.ts prepareServiceStart), then the follower (`serve`), the leader (`lead`) or
 * the daemon. Used by tests/providers/one-service-host-e2e.test.ts, one-service-lead-e2e.test.ts,
 * the boot proof test, and the host e2e harnesses (tests/helpers/replica-cluster.ts hostService,
 * tests/e2e/host-runs-sessions-e2e.test.ts).
 *
 * When the entry answers daemon: with WALNUT_TEST_SERVICE_DAEMON=1 it runs the session daemon as
 * main.ts does (`--service` in argv: the launcher's daemon, before a leader switched the host);
 * otherwise it prints `daemon <why>` and exits 3.
 * When it serves as the follower: WALNUT_TEST_SERVICE_AFTER may name a module the test wrote,
 * imported once the service's server answers (a test's read-only probes; the one seam the harness
 * keeps there).
 * MACHINE SAFETY: the test's temp dirs only (its env names them).
 */
import { pathToFileURL } from 'node:url'

// The runtime in a service names this file as its program (in-process-daemon.ts: argv[1]), so its
// `walnut` shim and wait_for's matcher run `<bun> <this file> walnut ...`: the daemon's own words,
// as main.ts hands them to it. Only `--service` (or no word: the boot proof's run) is the entry.
const word = process.argv[2]
const daemon = () => import('../../../src/providers/daemon-standalone.ts')
if (word !== undefined && word !== '--service') {
  await (await daemon()).runDaemonProcess()
} else {
  const { prepareServiceStart } = await import('../../../src/binary/service-start-hooks.ts')
  const { runHostService, runLeaderService } = await import('../../../src/binary/service-entry.ts')
  const decision = await prepareServiceStart(process.env, process.execPath)
  if (decision.kind === 'daemon') {
    if (process.env.WALNUT_TEST_SERVICE_DAEMON !== '1') {
      console.log(`daemon ${decision.why}`)
      process.exit(3)
    }
    if (!decision.quiet) process.stderr.write(`walnut --service: running as the session daemon (${decision.why})\n`)
    await (await daemon()).runDaemonProcess()
  } else if (decision.kind === 'lead') {
    await runLeaderService(decision, daemon)
  } else {
    const after = process.env.WALNUT_TEST_SERVICE_AFTER
    await runHostService(decision, daemon)
    if (after) await import(pathToFileURL(after).href)
  }
}
