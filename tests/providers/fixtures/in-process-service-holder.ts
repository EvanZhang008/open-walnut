/**
 * Run by tests/providers/one-service-lock.test.ts with bun: a stand-in Walnut service that runs the
 * session daemon of WALNUT_DAEMON_DIR in its own process (door open), prints `ready <pid>` and
 * holds the dir until its stdin closes, then stops the runtime and returns. With HOLDER_SERVICE_HOME
 * it holds it as a host's one Walnut service does (startInProcessDaemon's `service`).
 * MACHINE SAFETY: a temp root only; nothing is signalled.
 */
const DIR = process.env.WALNUT_DAEMON_DIR!
const { startInProcessDaemon, stopInProcessDaemon } = await import('../../../src/providers/in-process-daemon.ts')
const serviceHome = process.env.HOLDER_SERVICE_HOME
const started = await startInProcessDaemon({ dir: DIR, env: { ...process.env }, ...(serviceHome ? { service: { home: serviceHome } } : {}) })
console.log(`ready ${process.pid} ${started.kind}`)
await new Promise<void>((resolve) => { process.stdin.on('end', () => resolve()); process.stdin.on('close', () => resolve()); process.stdin.resume() })
await stopInProcessDaemon('test')
