/**
 * thread_audit: the thread check's daily counts (experiment threads_audit, core/org/thread-audit.ts,
 * routes web/routes/thread-audit-v1.ts), and with `run` one check of one node now. Every person's
 * action is an agent's too: the counts a person reads are the ones an agent reads.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import { badInput } from './own-refusal.js'

interface Counts { found?: Record<string, number>; reported?: Record<string, number>; fixed?: Record<string, number>; calls?: number; callMs?: number }
const sum = (r: Record<string, number> | undefined): number => Object.values(r ?? {}).reduce((a, b) => a + b, 0)
const kinds = (r: Record<string, number> | undefined): string => Object.entries(r ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'

defineOp({
  name: 'thread_audit',
  title: 'Thread check counts',
  description: 'The thread check (a small model and a few rules read open Threads every few hours; experiment threads_audit): per day, '
    + 'how many repeat, unasked, stale and thin cards it found, told the node and later saw fixed, and its model calls. '
    + 'days (default 7), task: one node. run: true with task checks that node now and tells it what is new; it changes no thread.',
  input: {
    days: z.number().int().min(1).max(60).optional().describe('How many days back (default 7)'),
    task: z.string().min(1).optional().describe('One node (a task that keeps Threads: id or unique prefix)'),
    run: z.boolean().optional().describe('With task: check it now'),
  },
  handler: async (args, call) => {
    if (args.run === true) {
      if (typeof args.task !== 'string') throw badInput('run needs task: the node to check.')
      const r = await call('POST', '/thread-audit/run', { task: args.task }) as { ran?: boolean; why?: string; running?: boolean; found?: Record<string, number>; told?: unknown[]; fixed?: Record<string, number>; delivery?: string }
      if (r.running) return withOutcome(r, 'The check still runs; its counts show on thread_audit soon.', 'Read thread_audit in a minute.')
      if (!r.ran) return withOutcome(r, `Nothing checked: ${r.why === 'off' ? 'the experiment threads_audit is off' : r.why ?? 'no open threads'}.`, 'No further action is required.')
      return withOutcome(r, `Checked: found ${kinds(r.found)}; told ${r.told?.length ?? 0} new (${r.delivery}); fixed since the last check: ${kinds(r.fixed)}.`, 'No further action is required.')
    }
    const q = new URLSearchParams()
    if (typeof args.days === 'number') q.set('days', String(args.days))
    if (typeof args.task === 'string') q.set('task', args.task)
    const r = await call('GET', `/thread-audit${q.toString() ? `?${q.toString()}` : ''}`) as { on?: boolean; days?: unknown[]; totals?: Counts }
    const t = r.totals ?? {}
    return withOutcome(r, `${r.on ? 'On' : 'Off'}. Over ${r.days?.length ?? 0} day(s) with checks: found ${sum(t.found)} (${kinds(t.found)}), told ${sum(t.reported)}, `
      + `fixed ${sum(t.fixed)} (${kinds(t.fixed)}); ${t.calls ?? 0} model call(s), ${Math.round((t.callMs ?? 0) / 1000)} s.`, 'No further action is required.')
  },
  tags: { readonly: false, remote: 'allow' },
})
