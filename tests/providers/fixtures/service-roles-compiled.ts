/**
 * Run by tests/providers/service-roles.test.ts: the daemon's argv handling as the compiled Walnut
 * file runs it (`walnut __daemon --service-roles`; main.ts has set the single-file facts by then).
 * MACHINE SAFETY: prints and exits; it starts no runtime.
 */
const { setSingleFile } = await import('../../../src/lib/single-file.ts')
setSingleFile({ root: '/nonexistent/runtime', daemonVersion: 'walnut-daemon-test', modules: {} })
const { runDaemonProcess } = await import('../../../src/providers/daemon-standalone.ts')
await runDaemonProcess([process.execPath, 'walnut', '--service-roles'])
