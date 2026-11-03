import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

/**
 * Passwords for agents (core/vault/agent.ts, routes/vault-agent-v1.ts). An agent names an
 * item and says why; the item's own setting and the person decide. There is no op that reads
 * the vault as the person does, and none that changes what agents may use.
 */

interface ItemView { id: string; title: string; type: string; sites?: string[]; envName?: string; fields: string[]; access: string; sensitive?: boolean }

function itemLine(i: ItemView): string {
  const where = [i.sites?.join(', '), i.envName ? `$${i.envName}` : ''].filter(Boolean).join(', ')
  return `${i.title}${where ? ` (${where})` : ''} [${i.id}]: ${i.fields.join(', ') || 'no field'}; ${i.access === 'allow' && !i.sensitive ? 'given without asking' : i.sensitive ? 'asks the person, with Face ID or Touch ID' : 'asks the person'}`
}

const USE_RULE = 'Use the values only for the purpose you gave. Never repeat them in a reply, a file, a commit, a log or another message.'

function useOutcome(body: unknown) {
  const b = (body ?? {}) as { status?: string; item?: ItemView; values?: Record<string, string>; via?: string; grantedUntil?: string; requestId?: string; mode?: string; downgraded?: string }
  if (b.status === 'released') {
    const how = b.via === 'allow' ? 'the item allows agents' : b.via === 'grant' ? `this task holds a grant until ${b.grantedUntil}` : `the person approved${b.grantedUntil ? `, for this task until ${b.grantedUntil}` : ''}`
    return withOutcome(b as Record<string, unknown>, `Released ${Object.keys(b.values ?? {}).join(', ')} of ${b.item?.title} (${how}).`, USE_RULE)
  }
  if (b.status === 'pending') {
    return withOutcome(b as Record<string, unknown>,
      `Waiting for the person to approve ${b.item?.title} on their Mac or phone${b.mode === 'biometric' ? ' with Face ID or Touch ID' : ''}.${b.downgraded ? ` ${b.downgraded}` : ''}`,
      'Call password_wait with id (requestId) and token (waitToken) until it is released, then go on. Do not ask again meanwhile.')
  }
  if (b.status === 'expired' || b.status === 'canceled') {
    return withOutcome(b as Record<string, unknown>, b.status === 'expired' ? 'Nobody answered in time: not released.' : 'The ask was withdrawn: not released.',
      'Ask again only if the step is still needed, and say so in your reply.')
  }
  return withOutcome(b as Record<string, unknown>, 'Still waiting for the person.', 'Call password_wait again.')
}

defineOp({
  name: 'password_list',
  title: 'Passwords an agent may ask for',
  description:
    'The items in the user\'s Walnut password vault that agents may ask for: name, sites, the env var an API key is used as, the fields it has, '
    + 'and whether it is given without asking or asks the user. Never a secret. Filter with `q` (name, site, env var) or `site` (a URL or host). '
    + 'Then password_use, or in a shell `walnut pass run --env NAME=<item> -- <command>`, which gives the command the secret without it ever '
    + 'entering your context. 403 agents_off: the user turned agent access off; 423 vault_locked: Passwords is locked on the Mac.',
  input: {
    q: z.string().max(200).optional().describe('Words in the name, site or env var'),
    site: z.string().max(500).optional().describe('A page URL or host: the items saved for that site'),
  },
  bind: { method: 'GET', path: '/vault/agent/items', query: ['q', 'site'] },
  mapResult: ({ body }) => {
    const items = ((body ?? {}) as { items?: ItemView[] }).items ?? []
    return withOutcome({ items } as Record<string, unknown>, items.length ? items.map(itemLine).join('\n') : 'No item matches that an agent may ask for.',
      items.length ? 'password_use with the item id and a purpose, or walnut pass run for a command.' : 'Ask the user to add the item in Passwords if the step needs it.')
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'password_use',
  title: 'Use a password from the vault',
  description:
    'Get fields of one vault item for a step you are doing now. Name the item (its id from password_list, its name, a site, or an env var name) '
    + 'and say why in `purpose`, in words the user reads on their phone ("sign in to git.example.com to merge PR 12"). '
    + 'An item that allows agents is released at once; otherwise the user gets a notification and approves or denies it '
    + '(Face ID or Touch ID for a sensitive item): you get `status: "pending"` with requestId and waitToken, then call password_wait. '
    + '`scope: "task"` asks for this task to use the item for an hour without asking again. Fields: password (default), username, totp '
    + '(the current one-time code), notes, card_number, card_code, card_expiry, or a custom field\'s name. '
    + 'The values come back in this result, so they are in your session\'s transcript from then on: use password_use only for a value you must '
    + 'type yourself (a browser sign-in, a form, a one-time code). For anything a command reads, use `walnut pass run --env NAME=<item> -- <command>`: '
    + 'the command gets the secret and you never see it. A task grant covers the fields the user approved, nothing more. '
    + 'Refusals: agent_never (the user keeps that item from agents: ask them to do the step), denied (do not ask again unless they say so), '
    + 'agent_paused (three denials: wait), agents_off, vault_locked, ambiguous (ask again with the id). ' + USE_RULE,
  input: {
    item: z.string().min(1).max(500).describe('Item id, name, site or env var name'),
    fields: z.array(z.string().max(100)).max(10).optional().describe('Fields to get (default ["password"])'),
    purpose: z.string().min(4).max(200).describe('Why, in a few words the user reads before approving'),
    scope: z.enum(['once', 'task']).optional().describe('once (default): this use only; task: this task, for an hour'),
    cwd: z.string().optional().describe('Your working directory, shown to the user'),
    command: z.string().optional().describe('The command the value is for, shown to the user'),
  },
  bind: { method: 'POST', path: '/vault/agent/use' },
  mapResult: ({ body }) => useOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'password_wait',
  title: 'Wait for a password the user approves',
  description:
    'Wait for the user to answer a password_use that came back pending: holds up to `wait_ms` (at most 12000) and returns the item\'s values '
    + 'once approved (`status: "released"`), `pending` while they have not answered, or `expired`/`canceled`. A denial is 403 denied. '
    + USE_RULE,
  input: {
    id: z.string().min(1).describe('requestId from password_use'),
    token: z.string().min(1).describe('waitToken from password_use'),
    wait_ms: z.number().int().min(0).max(12_000).optional().describe('How long to hold for an answer (default 12000)'),
  },
  bind: { method: 'POST', path: '/vault/agent/use/:id/wait' },
  timeoutMs: 20_000,
  mapResult: ({ body }) => useOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'password_cancel',
  title: 'Withdraw a password ask',
  description: 'Withdraw a password_use still waiting for the user, so it leaves their devices (the step is no longer needed).',
  input: {
    id: z.string().min(1).describe('requestId from password_use'),
    token: z.string().min(1).describe('waitToken from password_use'),
  },
  bind: { method: 'POST', path: '/vault/agent/use/:id/cancel' },
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, 'Withdrawn.', 'Nothing more to do.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
