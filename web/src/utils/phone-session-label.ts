/**
 * The one-line session status the phone shows (spec 4.2): a phone has no
 * tooltip, so the words that change a decision are visible text. Only four
 * readings, no permission mode, no phase / process pair:
 *   `Needs you: <tool>` (a prompt waits on a live process, it wins over the
 *   rest; a question reads `Needs your answer`), `Running`, `Idle`, `Stopped`
 *   (an errored or absent process reads as stopped, prompt or not).
 * A card the timeline draws unanswered wins over the process (N2-10): it is
 * there to answer, so the bar never says Stopped above it. A session whose
 * record is gone reads `Not available`. Before the record loads, with no list
 * surface having reported the session either, the bar says nothing (''), not a
 * default Stopped that turns into Running half a second later (N2-10).
 */
import { PROCESS_LABELS } from './session-status';

export type PhoneSessionLabel = `Needs you: ${string}` | 'Needs you' | 'Needs your answer' | 'Running' | 'Idle' | 'Stopped' | 'Not available' | '';

/**
 * Human words for the tools whose identifier means nothing to a person (N6):
 * a question is answered, a plan is reviewed. Other tools keep their name
 * (`Needs you: Bash` says what is about to run).
 */
const TOOL_WORDS: Record<string, PhoneSessionLabel> = {
  AskUserQuestion: 'Needs your answer',
  ExitPlanMode: 'Needs you: plan review',
};

export interface PhoneSessionLabelInput {
  process_status?: string | null;
  pendingPermissionTool?: string | null;
  /** The tool of the first unanswered card the timeline draws (usePendingCardTool). */
  cardTool?: string | null;
  /** The session's record is gone (404). */
  missing?: boolean;
  /** Its task is handed back to the user (NEED_ACTION): the home row reads Needs you. */
  taskNeedsYou?: boolean;
  /** The session's record is still loading: an unknown process is not Stopped. */
  loading?: boolean;
}

function needsYou(tool: string): PhoneSessionLabel {
  if (tool === 'a prompt') return 'Needs you';
  return TOOL_WORDS[tool] ?? `Needs you: ${tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')}`;
}

export function phoneSessionLabel(s: PhoneSessionLabelInput | null | undefined): PhoneSessionLabel {
  if (!s) return 'Stopped';
  if (s.missing) return 'Not available';
  const card = typeof s.cardTool === 'string' ? s.cardTool.trim() : '';
  if (card) return needsYou(card);
  const tool = typeof s.pendingPermissionTool === 'string' ? s.pendingPermissionTool.trim() : '';
  // Only a live process can take an answer (N6): a stopped session that still
  // carries an old prompt reads Stopped, as the desktop does, since there is
  // no card to answer in the overlay.
  const live = s.process_status === 'running' || s.process_status === 'idle';
  if (tool && live) return needsYou(tool);
  // The row on Home says Needs you for a task handed back; the bar says it too.
  if (s.taskNeedsYou && s.process_status !== 'running') return 'Needs you';
  if (s.loading && !s.process_status) return '';
  switch (s.process_status) {
    case 'running': return PROCESS_LABELS.running as 'Running';
    case 'idle': return PROCESS_LABELS.idle as 'Idle';
    default: return PROCESS_LABELS.stopped as 'Stopped';
  }
}
