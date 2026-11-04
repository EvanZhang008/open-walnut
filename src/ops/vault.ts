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

const LEAST_SEEN = 'Prefer a way that uses the secret without showing it to you: `walnut browser fill_login` for a sign-in page, '
  + '`walnut pass run --env NAME=<item> -- <command>` for a command or an API key. Reveal the plaintext only when neither works.'

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
    const b = (body ?? {}) as { items?: ItemView[]; off?: boolean; note?: string }
    const items = b.items ?? []
    if (b.off) return withOutcome({ items, off: true } as Record<string, unknown>, b.note ?? 'Agent access is Off: no list.', 'Ask for one item by its exact name only if the step needs it; the user approves it or not.')
    return withOutcome({ items } as Record<string, unknown>, items.length ? items.map(itemLine).join('\n') : 'No item matches that an agent may ask for.',
      items.length ? `${LEAST_SEEN} Otherwise password_use with the item id and a purpose.` : 'Ask the user to add the item in Passwords if the step needs it.')
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'password_use',
  title: 'Use a password from the vault',
  description:
    'Get fields of one vault item for a step you are doing now. Name the item (its id from password_list, its name, a site, or an env var name) '
    + 'and say why in `purpose`, in words the user reads on their phone ("sign in to git.example.com to merge PR 12"). '
    + 'What happens follows the user\'s setting: Any (the default) releases it at once, Ask sends the user an approval for each use, '
    + 'Off sends an approval for the one item you name; a sensitive item always asks (Face ID or Touch ID). Pending: you get `status: "pending"` '
    + 'with requestId and waitToken, then call password_wait. An approval lets this task use the item again for the user\'s grant length '
    + '(48 hours by default) without asking; `scope: "once"` asks for this use only. `use: "reveal"` (the default) is explicit: the plaintext '
    + 'comes back to you and Agent Activity records it as shown. ' + LEAST_SEEN + ' Fields: password (default), username, totp '
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
    scope: z.enum(['once', 'task']).optional().describe('task (default): an approval covers this task for the user\'s grant length; once: this use only'),
    use: z.enum(['reveal', 'env']).optional().describe('reveal (default): the plaintext comes back to you, logged as shown; env: what walnut pass run sends for a command\'s environment'),
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

defineOp({
  name: 'password_sync_bitwarden',
  title: 'Sync the vault from Bitwarden now',
  description:
    'One-way sync from the user\'s Bitwarden into their Walnut vault, run now: Walnut runs `bw sync` and `bw export` itself (with BW_SESSION from '
    + 'its environment or the Mac\'s keychain) and the export never reaches you. Takes no export: only the person\'s unlocked Passwords window may hand '
    + 'Walnut export text. New Bitwarden items are added (an earlier plain import of the same item is adopted when exactly one matches), changed ones '
    + 'updated (when the Walnut copy changed too, both are kept and the Walnut one is tagged conflict), deleted ones moved to the trash; a sync that '
    + 'would trash many items at once is not run (sync_mass_trash: only the person can allow it). Returns counts per type. In a shell: '
    + '`walnut pass sync-bitwarden`. Needs Passwords open on the Mac (423 vault_locked); refused while agent access is Off (agents_off).',
  input: {},
  bind: { method: 'POST', path: '/vault/sync/bitwarden/run' },
  timeoutMs: 400_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { summary?: string; report?: { ok?: boolean; error?: string; bitwarden?: Record<string, number>; linked?: Record<string, number> } }
    const per = (m?: Record<string, number>) => Object.entries(m ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'
    if (b.report && b.report.ok === false) {
      return withOutcome({ report: b.report, summary: b.summary } as Record<string, unknown>,
        `Not synced: ${b.report.error ?? 'unknown'}.`, 'Tell the user why; a locked vault or a missing BW_SESSION is theirs to fix.')
    }
    return withOutcome({ report: b.report, summary: b.summary } as Record<string, unknown>,
      `Synced from Bitwarden: ${b.summary ?? 'done'}. In Bitwarden: ${per(b.report?.bitwarden)}; linked in Walnut: ${per(b.report?.linked)}.`,
      'Report the counts to the user; never repeat an item\'s value.')
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
