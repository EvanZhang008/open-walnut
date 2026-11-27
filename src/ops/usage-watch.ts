/**
 * The real-use monitor's op (core/usage-watch/): a task that shipped a change arms a watch on
 * what real use should show, reads a target's numbers, or records why nothing can.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'

defineOp({
  name: 'usage_watch',
  title: 'Watch a shipped change in real use',
  description:
    'Real use of Walnut\'s tools, requests and pages (Settings > Diagnostics > Real Use). '
    + '`set`: after you ship a change, name what real use should show: `targets` (op:<tool>, route:<METHOD> <route template> (an /api/ route, kept as its server records it; one no route serves is refused), page:<page>: page:home, page:session-panel, page:task-detail, page:settings:<pane id>, page:app:<app id>; a page\'s uses are its visits, its own errors fail it), '
    + '`checks` ({max_answer_chars, max_fail_pct, no_new_codes, max_p95_ms, min_uses}; defaults 20000, 5, true, 2000, 20 (a page: 1 visit); a target with no use is never Passed; failures and new codes are Walnut\'s own errors and timeouts, while bad arguments and designed refusals come apart as caller_side), `who` ("this task" or an open task id), '
    + '`check_after` ("24h", 1h to 14d), or a `trigger` aimed at another open task for a check only a script can make. Until then an alarm on a target '
    + 'comes to that task, and at the check time each target is judged (Passed, Failed, Too little use, Unknown). A task that shipped cannot complete without one. '
    + '`exempt`: no watch, with `kind` (copy, colour, docs, tests, not_shipped, or watched_elsewhere: real use is watched outside Walnut, a pipeline alarm or a dashboard) and a `reason` of 20+ characters saying why (for watched_elsewhere: what watches it, who reads it, when). '
    + '`report`: the numbers of a `target` or the 15 names with the most problems (`range` 24h, 48h or 7d). `get` (`id`: one watch, its verdict), `list`, `drop` (`id`), '
    + '`errors`: failed Walnut tool calls as sessions read them, every host, grouped `by` op, code, session or host (`session`: one session or task, its failures one by one; `op`: one tool\'s; `code`: one error code\'s; `range`). '
    + '`ship` (record a ship from another release tool, `how`), `probe` (an answer of `chars` filler characters, for testing the alarms), `help` (each action with an example).',
  input: {
    action: z.enum(['set', 'exempt', 'get', 'drop', 'list', 'report', 'errors', 'ship', 'probe', 'help']).describe('What to do (help: each action with an example)'),
    targets: z.union([z.string(), z.array(z.string().max(200)).max(10)]).optional().describe('set: op:<tool>, route:<METHOD> <template>, page:<page> (page:home, page:session-panel)'),
    checks: z.object({
      max_answer_chars: z.number().optional(), max_fail_pct: z.number().optional(), no_new_codes: z.boolean().optional(),
      max_p95_ms: z.number().optional(), min_uses: z.number().optional(),
    }).strict().optional().describe('set: what each target must meet'),
    who: z.string().max(80).optional().describe('set: "this task" (default) or the id of an open task that watches it'),
    check_after: z.string().max(10).optional().describe('set: when the watch is judged, "24h" (1h to 14d)'),
    trigger: z.string().max(80).optional().describe('set: a trigger id that checks what the checks cannot'),
    task: z.string().max(80).optional().describe('The task the watch, exemption or ship is for (default: the calling session\'s)'),
    kind: z.enum(['copy', 'colour', 'docs', 'tests', 'not_shipped', 'watched_elsewhere']).optional().describe('exempt: what kind of change needs no watch'),
    reason: z.string().max(500).optional().describe('exempt: why nothing in real use can show this change (20+ characters)'),
    id: z.string().max(80).optional().describe('get, drop: the watch id'),
    target: z.string().max(200).optional().describe('report: one target (errors: op:<tool>, the same as op)'),
    range: z.enum(['24h', '48h', '7d']).optional().describe('report, errors: the time span (default 7d)'),
    by: z.enum(['op', 'code', 'session', 'host']).optional().describe('errors: how to group them (default op)'),
    session: z.string().max(80).optional().describe('errors: one session or task id, or its start'),
    op: z.string().max(80).optional().describe('errors: only the failures of this tool (its name, like task_send)'),
    code: z.string().max(80).optional().describe('errors: only the failures with this error code (like reply_language)'),
    how: z.string().max(60).optional().describe('ship: what shipped it'),
    chars: z.number().int().min(1).max(55_000).optional().describe('probe: the answer\'s length'),
  },
  bind: { method: 'POST', path: '/usage-watch' },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})
