import { defineCapability } from './manifest.js'

/**
 * The server is one witness of a switchable leader's write permission (docs/reference/leader-switch.md,
 * "How a witness is reached"): a witness a candidate machine reaches with no leader link, by its
 * direct door. The companion, or a host's service (`alsoHostReplica`: a dev box's `walnut web --replica`,
 * the same module), opens it when its env names it; off by default on both. On, the server keeps the
 * witness's record and key in its machine state dir (never in a data dir) and answers only a caller
 * that proves that key. No job, no socket door: HTTP routes (web/routes/witness-door.ts, the door's code
 * in core/leader/switch/witness-door.ts). The setup route is the companion's only: a host's witness is
 * set up over the leader's own link to it (the leader door's witness route), never a new credential.
 */
export const witnessDoor = defineCapability({
  name: 'witness-door',
  summary: "The box keeps one witness of a switchable leader's write permission and answers it on a direct door, proven with that witness's own key.",
  companionDefault: false,
  alsoHostReplica: true,
  jobs: [],
  doors: [],
  routes: [
    {
      path: '/leader-witness',
      opensWith: "only a caller that proves the witness's own key (32 random bytes minted at its setup, kept beside its record and in the leader's leader_switch config): a nonce from /challenge, good once for one call's digest for 10 s, then HMAC-SHA256 of the Walnut, witness, nonce and digest; a replay, an expired nonce, a nonce for another call, a wrong key or a wrong Walnut is refused before the record is read, and the witness proves the key over its reply. No device token or machine token opens it, and with no key set up it refuses every caller",
      verifiedIn: 'src/core/leader/switch/witness-door.ts',
      check: 'if (!proofsEqual(hmacProof(key, doorCallerProofText(fields)), r.proof))',
    },
    {
      path: '/bridge/witness-setup',
      opensWith: "on the companion only (a host's service does not mount it): only the paired Mac's own machine token (bridge-local), checked before the body is read, as every write the Mac makes to this box; it sets a witness up once (its record, its first list, its key) and never replaces a key; a device token or another machine's token gets 403, failures are rate limited per address",
      verifiedIn: 'src/web/routes/bridge-ingest.ts',
      check: "cred.kind !== 'machine' || cred.name !== PRIMARY_MACHINE_DEVICE",
    },
  ],
  reads: [
    'src/web/server.ts',
  ],
})
