/**
 * What this server is, said to clients in one shape (GET /api/config and
 * GET /api/v1/status), so a client reads the server's role, where it runs, the
 * capabilities it has and whether its leader answers, instead of guessing them
 * from `cloud` and `mode` (which both routes still send, unchanged, for older
 * clients).
 *
 *   role                leader | replica              core/server-role.ts role()
 *   placement           mac | host | cloud            core/server-role.ts placement()
 *   serverCapabilities  public-door, bridge-door, ... core/capabilities.ts capabilityList()
 *                       (named apart from /api/v1/status `capabilities`, its v1 feature list)
 *   leader              { answers, why, since }       core/server-role.ts leaderPresence()
 *                       (the Mac: answers true, why 'leader')
 */
import { capabilityList, type Capability } from '../core/capabilities.js'
import { leaderPresence, placement, role, type Placement, type ServerRole } from '../core/server-role.js'

export interface ServerFacts {
  role: ServerRole
  placement: Placement
  serverCapabilities: Capability[]
  leader: { answers: boolean; why: string; since: number }
}

export function serverFacts(): ServerFacts {
  return { role: role(), placement: placement(), serverCapabilities: capabilityList(), leader: leaderPresence() }
}
