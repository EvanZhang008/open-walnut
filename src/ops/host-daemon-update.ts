import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { sinceTime } from '../providers/daemon-update-wait.js';

const NEXT: Record<string, string> = {
  running: 'Call host_daemon_update again in a few minutes to see how it went; the host reconnects on the new build by itself.',
  checking: 'Call host_daemon_update again in a minute to see how it went.',
  updated: 'Nothing more to do.',
  failed: 'Read `message`; the running daemon keeps serving. Fix what it names, then ask again.',
  skipped: 'Read `message`: nothing was changed on the host.',
  postponed: 'Walnut asks again by itself in a minute.',
  held: 'Nothing was changed on the host.',
};

defineOp({
  name: 'host_daemon_update',
  title: 'Update a host\'s Walnut daemon now',
  description:
    'Update the Walnut session daemon on another host to this server\'s build, now: a host reached over SSH or one that joined '
    + 'over the host network. Walnut does this by itself after a deploy, but replaces a host\'s daemon at most once every 2 hours, '
    + 'so a fix to host-side code can wait that long; this op puts it there now (past that gap, a shared daemon kept, the busy '
    + 'clock, the cooldown after a try and a build\'s day off; never past writes in flight, host_exec runs, open ACP turns, an '
    + 'update still running there or another host name of the same daemon updating it). It is also the only way for a host whose '
    + 'config says `autofix: false`. Use it when the user wants it now, or when your task changed host-side code and needs it on '
    + 'that host. Running sessions there keep running; the host reconnects on the new build within a minute or two. Same grant as '
    + 'host_exec: the first call for this task on a host asks the user by letter (403 exec_grant_required). Answers once the update '
    + 'is decided or started (`phase`: running, updated, skipped, failed, postponed), with `running` (the build there now), '
    + '`expected` (the build this server puts there) and, while it waits, `message` and `until`; ask again for how it went. This '
    + 'Mac and the cloud box update another way (409 updates_itself).',
  input: {
    host: z.string().min(1).describe('Host alias (host_list names them)'),
  },
  bind: { method: 'POST', path: '/hosts/:host/daemon-update' },
  // The route dials the host (8 s at most) and waits up to 8 s for the decision.
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const phase = typeof b.phase === 'string' ? b.phase : 'unknown'
    const builds = typeof b.expected === 'string' && b.running !== b.expected ? ` [runs ${typeof b.running === 'string' ? b.running : 'unknown'}, this server's build ${b.expected}]` : ''
    // The head in this server's own time (as every update wait says it); `until` stays ms epoch in the data.
    const until = typeof b.until === 'number' ? ` until ${sinceTime(b.until)}` : ''
    const head = `${String(b.host)}: ${phase}${until}${typeof b.message === 'string' && b.message ? ` (${b.message})` : ''}${builds}.`
    return withOutcome(b, head, NEXT[phase] ?? 'Ask again to see how it went.')
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
