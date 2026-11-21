import { defineCapability } from './manifest.js'

/**
 * A host replica answers its own host's `walnut` calls while the Mac is away: a call of a
 * session or a plugin job on that host, which the daemon hands it ('follower-gateway-v1',
 * providers/follower-gateway-core.ts), runs through the same task logic the Mac runs
 * (core/peers/gateway-answer.ts) on the replica's copies, its writes journaled for the Mac.
 * It starts a session of a task of this host alone (replica/away-starts.ts) and delivers a
 * message to a session that runs here. Set by the host server manager when the host's daemon
 * can hand calls over; the companion never has it. The calls the daemon hands it come on the
 * replica's own follower link, and run with the replica's in-process credential.
 *
 * One way in of its own, behind the `host_call_entry` experiment: the host call entry
 * (replica/host-call-entry.ts), on a unix socket of its own in the daemon's dir, never on the
 * listener the host's tunnel reaches (there that path is 404). It decides nothing: each line goes
 * to the daemon, which runs it only for the token of the caller's current run.
 */
export const hostLocalCalls = defineCapability({
  name: 'host-local-calls',
  summary: "A host replica answers its host's sessions and plugin jobs, and starts their sessions there, while the Mac is away.",
  companionDefault: false,
  hostReplica: true,
  jobs: [],
  doors: [],
  routes: [
    {
      path: '/api/host/call',
      opensWith: "a process of this host's user only: the entry listens on <daemon dir>/host-call/<16 hex>.sock (0600 in a 0700 dir, like the daemon's gateway socket), not on the tunnel's listener; a request with forwarding headers is refused; the Bearer is the WALNUT_CALL_TOKEN the daemon gave one run it started (HMAC of the caller sid and that run's nonce), and the daemon runs the line only for the token of that sid's current run",
      verifiedIn: 'src/providers/daemon-standalone.ts',
      check: 'if (!hostCallTokens.verify(sid, cmd.token))',
    },
  ],
  reads: [
    'src/core/peers/capability-router.ts',
    'src/web/server.ts',
  ],
})
