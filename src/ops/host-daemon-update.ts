import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

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
    'Update the Walnut session daemon on another host to this server\'s build, now. For a machine that joined over the host '
    + 'network, Walnut does this by itself after a deploy, except on a host whose config says `autofix: false`: someone guards that '
    + 'machine, so its daemon is updated only when asked, by this op. Ask only when the user wants it now (they named the host or '
    + 'the update). Running sessions there keep running; the host reconnects on the new build within a minute or two. Same grant '
    + 'as host_exec: the first call for this task on a host asks the user by letter (403 exec_grant_required). Answers once the '
    + 'update is decided or started (`phase`: running, updated, skipped, failed, postponed); ask again for how it went. A host Walnut '
    + 'reaches over SSH, this Mac and the cloud box update another way (409 updates_itself).',
  input: {
    host: z.string().min(1).describe('Host alias (host_list names them)'),
  },
  bind: { method: 'POST', path: '/hosts/:host/daemon-update' },
  // The route dials the host (8 s at most) and waits up to 8 s for the decision.
  timeoutMs: 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const phase = typeof b.phase === 'string' ? b.phase : 'unknown'
    const head = `${String(b.host)}: ${phase}${typeof b.message === 'string' && b.message ? ` (${b.message})` : ''}.`
    return withOutcome(b, head, NEXT[phase] ?? 'Ask again to see how it went.')
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
