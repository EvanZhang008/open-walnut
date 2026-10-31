/**
 * Which form a "Needs you" row's Answer takes (OrgInlineAnswer.tsx), read from the ask's own
 * structure, never from its words; and the decision letter it answers. Pure, so tests reach it
 * without the component's UI graph.
 */
import { isOpenDecision, type LetterEnvelope } from '@/api/human-inbox';
import type { OrgAlertView } from './org-channels-model';

/** Which form the ask takes. */
export type AnswerShape = 'prompt' | 'letter' | 'choice' | 'words';

export function answerShape(a: OrgAlertView): AnswerShape {
  if (a.kind === 'question' || a.kind === 'permission') return 'prompt';
  if (a.kind === 'needs' && a.source === 'prompt') return 'prompt';
  if (a.kind === 'needs' && a.source === 'letter') return 'letter';
  if (a.kind === 'needs' && a.source === 'choice') return 'choice';
  return 'words';
}

/** The newest decision letter from this task still waiting on the user. */
export function openLetterFor(letters: readonly LetterEnvelope[], taskId: string, now = Date.now()): LetterEnvelope | null {
  let best: LetterEnvelope | null = null;
  for (const l of letters) {
    if (l.sender.taskId !== taskId || !isOpenDecision(l, now) || !l.actions?.length) continue;
    if (!best || l.createdAt > best.createdAt) best = l;
  }
  return best;
}
