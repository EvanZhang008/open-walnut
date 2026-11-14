/**
 * The shape of one capability (src/core/capabilities.ts is the registry that lists them).
 *
 * A capability is what a replica offers beyond the replica core: a door to the
 * outside, a job the box runs for itself. Everything one capability does is
 * named in its manifest, one file in this folder, so a reader (or a security
 * review) finds its whole surface in one place:
 *
 *   jobs    the boot policy rows it turns on for a replica (src/core/boot-policy.ts)
 *   doors   the socket paths it opens, each with the one credential that may open it
 *   routes  the HTTP paths it mounts that the /api device-token check does not cover
 *   reads   every file that asks hasCapability(<name>) or the web's useServerCapability
 *
 * tests/core/capability-manifests.test.ts keeps all four exact against the code.
 * Manifests are compiled in: nothing loads a capability from disk, a plugin or
 * the network, and a name the box sets that no manifest has stops its boot.
 */
import type { BootJob } from '../boot-policy.js'

/** A way in from outside: a socket path or an HTTP path, and who may come in. */
export interface Entrance {
  path: string
  /** Who may come in and with what credential, in sentences a reviewer can check against the code. */
  opensWith: string
  /** The file that checks that credential before anything else happens. */
  verifiedIn: string
  /** The credential check itself, as it reads in that file's code (the test finds it there). */
  check: string
}

export interface CapabilityManifest<N extends string = string> {
  /**
   * The wire name: in WALNUT_CAPABILITIES, in `serverCapabilities` of GET /api/config and
   * /api/v1/status, and in the boot policy line. Never renamed: phones and browsers read it.
   */
  name: N
  /** What it adds to a replica, one sentence a person reads. */
  summary: string
  /**
   * Whether a companion that sets no WALNUT_CAPABILITIES has it. Only the four that
   * existed before the variable say true: a new capability is off on every box until
   * the box names it, so an update never opens a new door on its own.
   */
  companionDefault: boolean
  /** The boot policy rows it turns on for a replica, in the table's order. */
  jobs: readonly BootJob[]
  /** The socket (WebSocket upgrade) doors it opens on this server. */
  doors: readonly Entrance[]
  /** The HTTP paths it mounts outside the /api device-token check, each with its own. */
  routes: readonly Entrance[]
  /**
   * Every source file (src/, web/src/) that asks whether this server has it with a literal
   * name. A wrapper that asks for it (canStandIn, a default argument) counts as its own
   * file's read; its callers are not listed.
   */
  reads: readonly string[]
}

/** Identity, typed so the registry keeps each manifest's name as a literal. */
export function defineCapability<const N extends string>(manifest: CapabilityManifest<N>): CapabilityManifest<N> {
  return manifest
}
