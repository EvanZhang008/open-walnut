/**
 * Every place Walnut asks the user to approve something, decided once (2026-11-01, the
 * user: "why must you ask me, can't it just use it, stop asking me, change our code").
 * The rule: what the user's own tasks do on the user's own machines asks no one; only the
 * user's standing exceptions ask (an outward send, spending, credentials, deleting cloud
 * resources), and a prompt in a mode the user picked for that session (plan approval, the
 * permission cards of a session not in bypass).
 *
 * A new file that writes a letter with buttons, or a new place that raises a tool
 * permission card, fails here until it is added below with its decision.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** Files that send a letter carrying actions (buttons the user answers). */
const LETTER_ASKS: Record<string, string> = {
  // A task on a host the user did NOT register (or one whose grant they revoked) using
  // another; a task on a registered host gets its grant with no letter (exec-grants.ts).
  'src/core/hosts/host-exec.ts': 'own machines: asks only for an unregistered caller host or a revoked grant',
  'src/integrations/mail/approvals.ts': 'outward send: an email leaves the user\'s machines',
  'src/integrations/mail/unsubscribe.ts': 'outward send: contacts an outside sender',
  'src/core/plugins/server-api.ts': 'plugin pass-through: the plugin owns its own asks',
  'src/core/private-tasks/sync-gate.ts': 'outward send: a task Walnut kept out of an outside service as private goes there only when the user says so',
}
// Not a Walnut ask: a task's own letter (human_inbox_send, any actions it names) is the
// task's words, held to the inbox rule (only the user's decisions) in its prompt and op help.

/** Files that raise a tool permission card (SESSION_PERMISSION_REQUEST). */
const PERMISSION_CARDS: Record<string, string> = {
  // Only outside bypass (the default task mode where the host allows it): a mode the user
  // picked for that session. shouldAutoRespond's table is pinned in
  // tests/providers/session-mode-registry.test.ts.
  'src/providers/claude-code-session.ts': 'session mode the user picked (default, acceptEdits, plan approval)',
  'src/providers/acp-session.ts': 'session mode the user picked (ACP without full access)',
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

const files = sources('src').map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }))

describe('approval prompts for the user', () => {
  it('every letter with buttons is a decided ask', () => {
    const found = files
      .filter(({ text }) => /\b(sendLetter|sendLetterOnce|letters\.send)\s*\(|_LETTER_ACTIONS\b/.test(text) && /^\s*actions\s*[:,]/m.test(text))
      .map(({ f }) => f)
      .sort()
    expect(found, 'A new letter with buttons asks the user to approve something: add it to LETTER_ASKS with its decision, or let it act without asking').toEqual(Object.keys(LETTER_ASKS).sort())
  })

  it('every tool permission card is a decided ask', () => {
    const found = files
      .filter(({ text }) => /bus\.emit\(\s*EventNames\.SESSION_PERMISSION_REQUEST/.test(text))
      .map(({ f }) => f)
      .sort()
    expect(found, 'A new place raises a permission card: add it to PERMISSION_CARDS with its decision').toEqual(Object.keys(PERMISSION_CARDS).sort())
  })

  it('the grant letter is written only after the own-host check', () => {
    const text = files.find(({ f }) => f === 'src/core/hosts/host-exec.ts')!.text
    const own = text.indexOf('await isOwnHost(caller.host)')
    const letter = text.indexOf('await sendLetter(')
    expect(own).toBeGreaterThan(0)
    expect(letter).toBeGreaterThan(own)
  })
})
