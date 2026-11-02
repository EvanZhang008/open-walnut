/**
 * A decision letter from a task session names which of the user's own kinds it is (org/user-kind.ts).
 *
 * 2026-11-01, the user: "why ask me, just go, make your decision": a task asked a question it could
 * have decided itself and its lead handed it on to the user. The charter and USER.md already said so;
 * this is the check. Every `action_required` letter a task session sends is judged (Main, a lead or a
 * worker: nothing sends a worker's letter to its lead first). Not judged: a plugin's, Walnut's own
 * (mail approvals), an Inbox Triage run's (its decisions are mail steps with their own budget) and a
 * host's journal op; `user_asked` does not skip it, because that flag is the agent's own claim and
 * `user_own` already covers what the user asked to decide. Without a kind and a reason the letter is
 * refused (409 `user_kind`); with them they lead the body, so the user reads why it is theirs.
 */
import { log } from '../../logging/index.js';
import { userKindLead, userKindVerdict } from '../org/user-kind.js';
import { LetterError } from './store.js';
import type { LetterSender, NewLetter } from './types.js';

type LetterInput = Omit<NewLetter, 'sender'>;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The letter without the kind fields (never stored). */
export function withoutUserKind(input: LetterInput): LetterInput {
  const { userKind: _a, user_kind: _b, userKindWhy: _c, user_kind_why: _d, ...rest } = input;
  return rest;
}

/** The letter as it may go out (the kind leading its body), or a 409. */
export async function admitUserKindLetter(input: LetterInput, sender: LetterSender): Promise<LetterInput> {
  const rest = withoutUserKind(input);
  if (input.type !== 'action_required') return rest;
  if (!sender.taskId || !sender.sessionId || sender.sessionId === 'external' || sender.pluginId) return rest;
  // A letter the store would refuse anyway (no options, a bad shape) gets the store's own teaching
  // message first, not a second round trip for the kind.
  const { createLetterCheck } = await import('./letter-check.js');
  if (!createLetterCheck().shape(rest as unknown as Record<string, unknown>).ok) return rest;
  const { isTriageSender } = await import('./triage-quota.js');
  if (await isTriageSender(sender, {})) return rest;
  const verdict = userKindVerdict(input);
  if (!verdict.ok) {
    log.notif.info('human-inbox: decision letter refused, no user kind named', { senderTaskId: sender.taskId });
    throw new LetterError(verdict.message, 'user_kind', 409);
  }
  log.notif.info('human-inbox: decision letter from a node', { senderTaskId: sender.taskId, kind: verdict.kind, why: verdict.why });
  const { walnutLetterLanguage } = await import('./walnut-letters/languages.js');
  const lead = userKindLead(verdict, await walnutLetterLanguage());
  if (typeof rest.markdown === 'string') return { ...rest, markdown: `_${lead.replace(/([_*\\])/g, '\\$1')}_\n\n${rest.markdown}` };
  if (typeof rest.html === 'string') return { ...rest, html: `<p><em>${escapeHtml(lead)}</em></p>\n${rest.html}` };
  const preview = typeof rest.text === 'string' && rest.text.trim() ? `${lead}. ${rest.text}` : lead;
  return { ...rest, text: preview };
}
