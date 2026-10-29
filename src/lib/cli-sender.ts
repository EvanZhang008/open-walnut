/**
 * Who stands behind a `walnut tools call` made outside every Walnut session.
 *
 * With no session id the server took such a call for the user: on 2026-10-28 a
 * LaunchAgent (the Mac load watchdog) sent task_send notes that four tasks read as
 * the user talking to them. The rule: a person types `walnut` in a terminal, so a
 * call with a terminal on stdin, stdout or stderr is the person; a call with none
 * (a LaunchAgent, cron, a script piping output) is an automation, named by
 * `WALNUT_SENDER` (default "script"). `WALNUT_SENDER=person` keeps a person's own
 * pipeline theirs. Older servers ignore the headers this sets, older CLIs send none:
 * both read as before.
 */

export const CALLER_KIND_HEADER = 'x-walnut-caller-kind';
export const SENDER_LABEL_HEADER = 'x-walnut-sender';

const PERSON = new Set(['person', 'user', 'me', 'human']);

/** A short plain label, safe in a header and an envelope attribute. */
export function senderLabel(raw: string | undefined): string {
  const label = (raw ?? '').replace(/[^A-Za-z0-9 ._:/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return label || 'script';
}

/**
 * The automation's label, or undefined when the caller is a session (it says so itself)
 * or a person. `ttys` is injectable for tests.
 */
export function cliAutomationSender(
  env: NodeJS.ProcessEnv = process.env,
  ttys: readonly boolean[] = [!!process.stdin.isTTY, !!process.stdout.isTTY, !!process.stderr.isTTY],
): string | undefined {
  if ((env.WALNUT_SESSION_ID ?? '').trim()) return undefined;
  const named = (env.WALNUT_SENDER ?? '').trim();
  if (named) return PERSON.has(named.toLowerCase()) ? undefined : senderLabel(named);
  return ttys.some(Boolean) ? undefined : 'script';
}
