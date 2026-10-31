import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

defineOp({
  name: 'secret_list',
  title: 'The secrets the user shared with hosts',
  description:
    'The secrets the user keeps in Walnut and the hosts each is copied to, so a task on a host can use one while the Mac is away: '
    + 'name, hosts, the env var a session there gets it as (`env`, when `sessions`), its version, and each host\'s copy '
    + '(`copies.<host>.version`, `error` when the last send failed). Never a value. On a host, a session reads one from '
    + '`$WALNUT_SECRETS_DIR/<name>` inside the command that needs it; never print a value. Only the user adds, rotates, '
    + 'shares or deletes a secret (Settings › Remote Hosts › Secrets): ask them in your reply when one is missing.',
  input: {
    host: z.string().optional().describe('Only the secrets shared with this host'),
  },
  bind: { method: 'GET', path: '/secrets' },
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { secrets?: Array<{ name: string; hosts: string[]; env?: string; sessions?: boolean }> }
    const secrets = b.secrets ?? []
    const lines = secrets.map((s) => `${s.name}: ${s.hosts.join(', ') || 'no host'}${s.env && s.sessions ? ` (sessions get $${s.env})` : ''}`)
    return withOutcome({ ...b, secrets } as Record<string, unknown>, lines.length ? lines.join('\n') : 'No secret is shared with a host yet.',
      'Use one from $WALNUT_SECRETS_DIR/<name> inside the command that needs it.')
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
