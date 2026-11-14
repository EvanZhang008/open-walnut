import { defineCapability } from './manifest.js'

/**
 * The server starts and owns the daemon of its own machine (src/core/cloud-exec.ts).
 * A host replica never does: its machine's daemon belongs to the Mac's link. The
 * daemon listens on loopback only; whether a phone may start sessions on it while
 * the Mac is away is the user's own setting, cloud.exec.enabled, off by default.
 */
export const cloudExec = defineCapability({
  name: 'cloud-exec',
  summary: "The server runs its own machine's daemon, so sessions can run on the box (the user's cloud.exec.enabled decides whether a phone may start them).",
  companionDefault: true,
  jobs: ['cloud-exec', 'local-daemon', 'stream-file-cleanup', 'send-path-canary'],
  doors: [],
  routes: [],
  reads: [
    'src/core/cloud-owned-session.ts',
    'src/core/send-path-canary.ts',
    'src/web/routes/api-v1.ts',
    'src/web/routes/session-launch-v1.ts',
    'src/web/ws/daemon-tunnel.ts',
  ],
})
