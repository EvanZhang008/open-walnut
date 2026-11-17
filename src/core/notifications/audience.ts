/**
 * Who a notice is for: the ONE rule every surface of Walnut follows.
 *
 *   user    the person sees it: a toast in the corner stack and a row in the bell.
 *   health  it goes to Settings > Walnut Health only (grouped by category, with
 *           counts, first and last seen, and the raw details), for whoever
 *           investigates. It never toasts and never sits in the bell.
 *
 * An error reaches the person only when it says why it needs them (`needsYou`):
 * they must sign in or set something up, the data disk is full, sync stopped and
 * waits for them, an action they took themselves failed, or a plugin says its
 * person must act. Every other error (a log line, a session or subagent failure,
 * a backup retry, a phone's freeze report, a plugin handler that threw) is
 * Walnut's to fix and goes to Health (2026-11-17, the user: only the errors he
 * needs to see, the rest in Walnut Health).
 *
 * A host problem (kind `host`: a remote machine Walnut cannot reach or use) follows
 * the same rule: Walnut reconnects by itself and its health monitor investigates,
 * so it reaches the person only when only they can clear it (a login, a changed
 * host key: `HOST_SIGN_IN_KINDS`) or it answers their own Retry or Connect
 * (2026-11-17, the user: a machine that is not connected must not ask him to run
 * a command; errors resolve themselves, and only a possible problem reaches him).
 *
 * Asks, letters, reminders and automation receipts are not errors: they stay the
 * person's, as before.
 *
 * Leaf module, no imports: the web app reads the same file through the
 * `@open-walnut/notice-audience` alias, so the server and the browser can never
 * decide differently. The field is derived, never stored, so a record an older
 * version wrote is classified by today's rule.
 */

/** Why an error needs the person. Closed list: a new reason is a decision, made here. */
export const NEEDS_YOU_REASONS = [
  /** Sign in again, or finish setting something up (a plugin, the agent's credentials). */
  'sign-in',
  /** The data disk is full enough that writes stop. */
  'disk-full',
  /** Data sync stopped to protect data and waits for a person to look. */
  'sync-stopped',
  /** An action the person took themselves failed for good. */
  'own-action',
  /** A plugin raised the error and said its person must act (PluginNotice.needsYou). */
  'plugin-asks',
] as const;

export type NeedsYou = typeof NEEDS_YOU_REASONS[number];

export type NoticeAudience = 'user' | 'health';

export interface AudienceInput {
  kind: string;
  needsYou?: string;
  dedupKey?: string;
}

/**
 * Cards an older version wrote before `needsYou` existed, by the keys their producers have
 * always used, so an open sign-in, disk-full or safe-mode card does not move to Walnut Health
 * on upgrade and wait there for a producer that may never fire again (a parked mail account).
 * Every one of these producers now names its reason too.
 */
const LEGACY_PERSON_KEYS: ReadonlyArray<{ re: RegExp; reason: NeedsYou }> = [
  { re: /^error:plugin:[^:]+:(sign-in|not-configured)$/, reason: 'sign-in' },
  { re: /^plugin:[^:]+:account-auth:/, reason: 'plugin-asks' },
  { re: /^error:disk:critical$/, reason: 'disk-full' },
  { re: /^error:health:disk\.free/, reason: 'disk-full' },
  { re: /^error:git:safe-mode$/, reason: 'sync-stopped' },
  { re: /^found-host:/, reason: 'own-action' },
  { re: /^chat-interrupted:/, reason: 'own-action' },
];

/** Why an error needs the person: its own reason, or the one its key has always meant. */
export function needsYouOf(n: AudienceInput): NeedsYou | undefined {
  if (isNeedsYou(n.needsYou)) return n.needsYou;
  const key = n.dedupKey;
  return key ? LEGACY_PERSON_KEYS.find(e => e.re.test(key))?.reason : undefined;
}

export function isNeedsYou(value: unknown): value is NeedsYou {
  return typeof value === 'string' && (NEEDS_YOU_REASONS as readonly string[]).includes(value);
}

/** The kinds that are judged by their reason: an error, and a host problem. */
const REASON_KINDS: readonly string[] = ['operation-error', 'host'];

/** The rule. An error or a host problem without a known reason is Walnut Health's. */
export function audienceOf(n: AudienceInput): NoticeAudience {
  if (!REASON_KINDS.includes(n.kind)) return 'user';
  return needsYouOf(n) ? 'user' : 'health';
}

/**
 * Host problem kinds only the person can clear: a login of theirs expired or is missing
 * (an SSH certificate, the SSH agent, a proxy's login, a refused key), the host's key changed
 * (a security call), Claude Code there is signed out, or the machine cannot run Walnut's work
 * at all and no reconnect heals it (a name that does not resolve, not Linux, Claude Code
 * missing or broken there). Every other kind (a machine that is off or asleep, a network, a
 * daemon that did not start) Walnut retries and investigates.
 */
export const HOST_SIGN_IN_KINDS: readonly string[] = [
  'auth', 'host_key', 'cert_expired', 'agent_missing', 'proxy_login', 'claude_not_logged_in',
  'dns', 'not_linux', 'claude_missing', 'claude_needs_node', 'claude_error',
];

/** Why a host problem needs the person, or undefined when it is Walnut Health's. */
export function hostProblemNeedsYou(p: { kind?: string; hosts: readonly string[] }, engaged: ReadonlySet<string>): NeedsYou | undefined {
  if (p.hosts.some((h) => engaged.has(h))) return 'own-action';
  return p.kind && HOST_SIGN_IN_KINDS.includes(p.kind) ? 'sign-in' : undefined;
}

export function isHealthNotice(n: AudienceInput): boolean {
  return audienceOf(n) === 'health';
}
