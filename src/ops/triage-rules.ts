/**
 * Inbox Triage routing-rule ops: the standing "mail about X goes to task Y" table every triage
 * batch reads (core/triage/routing-rules.ts, routes/triage-rules-v1.ts).
 *
 * Writes are the user's, Main's or a VP's, refused for anyone else where the route is served;
 * `triage_route` is the run's hand-off of one matched item, and names the rule on the message.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

const RULES = '/triage/routing-rules'

defineOp({
  name: 'triage_rule_list',
  title: 'List Inbox Triage routing rules',
  description:
    'The standing routing rules Inbox Triage applies on every batch: each says which mail or Slack '
    + 'items (a sender or subject to match, case-insensitive) go to which task, who wrote it, and the '
    + 'items it routed last. The user keeps them in Settings > Inbox Triage.',
  input: {},
  bind: { method: 'GET', path: RULES },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'triage_rule_set',
  title: 'Add or change an Inbox Triage routing rule',
  description:
    'Add a routing rule (no rule_id) or change one (rule_id): items whose sender contains `from` and/or '
    + 'whose subject contains `subject` (case-insensitive; a Slack message\'s text counts as its subject) '
    + 'go to task_id on every Inbox Triage batch from now on. Only the user, Main or a VP may write rules '
    + '(403 routing_rule_writer for anyone else: ask your lead; an Inbox Triage run passes the user\'s words to Main). Use it when the user says where a kind '
    + 'of mail belongs ("mail about X goes to task Y"), so the routing outlives the run that heard it.',
  input: {
    rule_id: z.string().optional().describe('The rule to change (rr-…); omit to add a new rule'),
    from: z.string().max(200).optional().describe('Text the sender contains (a name, an address, a domain); "" clears it'),
    subject: z.string().max(200).optional().describe('Text the subject contains; "" clears it. At least one of from / subject'),
    task_id: z.string().optional().describe('The task the matched items go to (required for a new rule)'),
    note: z.string().max(500).optional().describe('Why, in a sentence the triage run reads'),
    enabled: z.boolean().optional().describe('false turns the rule off without removing it'),
    position: z.number().int().min(0).optional().describe('Where the rule goes in the list, 0 = first (the first matching rule wins)'),
    before: z.string().optional().describe('Place the rule right above this rule (rr-…), resolved against the list as it is now'),
  },
  handler: async ({ rule_id, ...fields }, call) => {
    const id = typeof rule_id === 'string' && rule_id.trim() ? rule_id.trim() : ''
    const body = await call(id ? 'PATCH' : 'POST', id ? `${RULES}/${encodeURIComponent(id)}` : RULES, fields) as
      { rule?: { id?: string; matchText?: string; taskTitle?: string; taskId?: string } }
    const r = body?.rule
    return withOutcome(body ?? {}, `${id ? 'Changed' : 'Added'} routing rule ${r?.id ?? ''}: ${r?.matchText ?? ''} goes to "${r?.taskTitle ?? r?.taskId ?? ''}".`,
      'Every Inbox Triage batch from now on reads it.')
  },
  routes: [{ method: 'POST', path: RULES }, { method: 'PATCH', path: `${RULES}/:id` }],
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'triage_rule_delete',
  title: 'Remove an Inbox Triage routing rule',
  description: 'Remove a routing rule for good (triage_rule_set enabled=false only turns it off). The user, Main or a VP only.',
  input: { rule_id: z.string().min(1).describe('The rule (rr-…)') },
  bind: { method: 'DELETE', path: `${RULES}/:rule_id` },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'triage_route',
  title: 'Hand a triaged item to its routing rule\'s task',
  description:
    'Inbox Triage: send one mail or Slack item a routing rule matched to that rule\'s task. The task '
    + 'receives your text under a line naming the rule that routed it; it is not asked to reply. The '
    + 'rule records the item, so the user sees in Settings what each rule routed.',
  input: {
    rule_id: z.string().min(1).describe('The matching rule (rr-…), as the batch lists it'),
    item: z.string().min(1).max(200).describe('The item\'s subject (mail) or first words (Slack)'),
    text: z.string().min(1).describe('What arrived (sender, message id, account) and what it asks'),
    source: z.enum(['mail', 'slack']).optional().describe('Where the item came from'),
  },
  bind: { method: 'POST', path: `${RULES}/:rule_id/route` },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})
