import { defineCapability } from './manifest.js'

/**
 * The box may stand in for the Mac (src/core/leader/backup-leader.ts): when the
 * Mac's heartbeat stops and the user allowed it, it asks each host's daemon for
 * the lead. A daemon grants it only when it cannot hear the Mac either, and
 * refuses anything from an older epoch. While it leads a host it answers that
 * host's gateway calls and routes its messages; the Mac's routines, overviews and
 * project summaries never run on the box. Its own routine engine runs only the
 * box's git sync and backup jobs (cron/jobs.ts cloudModeSkipsJob), leading or not.
 */
export const backupLeader = defineCapability({
  name: 'backup-leader',
  summary: "It may lead the hosts while the Mac is away and the user allowed it; its own routine engine runs only the box's git sync and backup jobs.",
  companionDefault: true,
  jobs: ['backup-leader', 'routine-wake', 'cron'],
  doors: [],
  routes: [],
  reads: [
    'src/core/leader/backup-leader.ts',
    'src/core/server-role.ts',
    'src/web/routes/session-stop-v1.ts',
  ],
})
