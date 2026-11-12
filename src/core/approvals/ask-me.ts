/**
 * Whether an agent's step waits for the person's yes (2026-11-12, the user: "can we make this
 * optional, and I want it to be off by default don't need my approval for anything").
 *
 * `config.approvals.ask_me` absent or false (the default): no step waits. A post, a mail, a
 * browser step that buys, sends or deletes, a script's `walnut approve`, a hand-off outside a
 * router's area, a command on a new host, all go ahead, and each is recorded where the person
 * reads it afterwards (`unasked` on an approved record: `walnut approvals list --all`, the
 * plugin's own sent log). `true`: every one asks, as before.
 *
 * What it never turns off: a signed single-use approval (only its device can sign it; a script
 * that wants it asks with --single-use and reads this switch itself, `askMeOf`), a new signing
 * device without its app's proof (the trust root), an OS dialog the system itself shows, a
 * password item the person marked never or sensitive, and the person-only doors (settings,
 * answering an approval). Only a person changes the switch (routes/config.ts).
 *
 * Every gate that waits for the person reads `asksPerson()`; tests/core/approvals/ask-me-gates-guard.test.ts
 * lists them from the source and fails on a new one that does not.
 */
import { getConfig } from '../config-manager.js'
import type { ApprovalRequester, ApprovalView } from './types.js'

/** The gates the switch covers, by name (the `unasked` mark on a record). */
export const ASK_ME_GATES = {
  approve: 'A script or agent asked with walnut approve',
  browserOutward: 'A browser step that buys, sends or deletes',
  browserSignIn: 'A fresh sign-in on a site open in your own tab',
  routerHandoff: 'A hand-off outside a router task’s area',
  mailSend: 'Sending a mail',
  mailUnsubscribe: 'Unsubscribing from a mailing list',
  slackPost: 'Posting to Slack',
  hostExec: 'Running commands on a host',
  calendarWrite: 'Changing a calendar event Walnut did not create',
  vaultUse: 'An agent using a saved password',
} as const
export type AskMeGate = keyof typeof ASK_ME_GATES

/**
 * The switch as stored: true only when the person turned approvals on. With nothing stored,
 * `WALNUT_APPROVALS_ASK=1` makes the default "ask" (the test setup's default, as with
 * WALNUT_ORG_AUTOSTART); a stored value always wins.
 */
export function askMeOf(config: { approvals?: { ask_me?: boolean } } | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const stored = config?.approvals?.ask_me
  if (typeof stored === 'boolean') return stored
  return env.WALNUT_APPROVALS_ASK === '1'
}

/** Whether a step waits for the person now. */
export async function asksPerson(): Promise<boolean> {
  return askMeOf(await getConfig())
}

/**
 * Approvals are off: the step goes ahead, recorded as an approved approval nobody was asked
 * (no notice, no push, no word to the asker). Returns that record.
 */
export async function goAheadUnasked(gate: AskMeGate, input: { what: string; detail?: string; requester: ApprovalRequester; testRun?: string }): Promise<ApprovalView> {
  const { createApproval } = await import('./store.js')
  const { approval } = await createApproval({
    what: input.what.length > 300 ? `${input.what.slice(0, 299)}…` : input.what, ...(input.detail ? { detail: input.detail } : {}), mode: 'tap', requester: input.requester,
    unasked: gate, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  return approval
}
