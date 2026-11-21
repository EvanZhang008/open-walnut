import { defineCapability } from './manifest.js'

/**
 * A host replica answers its own host's `walnut` calls while the Mac is away: a call of a
 * session or a plugin job on that host, which the daemon hands it ('follower-gateway-v1',
 * providers/follower-gateway-core.ts), runs through the same task logic the Mac runs
 * (core/peers/gateway-answer.ts) on the replica's copies, its writes journaled for the Mac.
 * It starts a session of a task of this host alone (replica/away-starts.ts) and delivers a
 * message to a session that runs here. Set by the host server manager when the host's daemon
 * can hand calls over; the companion never has it. It opens no door: the calls come on the
 * replica's own follower link, and run with the replica's in-process credential.
 */
export const hostLocalCalls = defineCapability({
  name: 'host-local-calls',
  summary: "A host replica answers its host's sessions and plugin jobs, and starts their sessions there, while the Mac is away.",
  companionDefault: false,
  hostReplica: true,
  jobs: [],
  doors: [],
  routes: [],
  reads: [
    'src/core/peers/capability-router.ts',
    'src/web/server.ts',
  ],
})
