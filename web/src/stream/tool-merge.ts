/**
 * Which tool calls fold into a merged "Ran 3 commands ›" run: ONE rule for the
 * live stream (group-blocks.ts) and the saved rows (SessionMessage.tsx).
 *
 * The two used to keep a list each. A message to another session (a
 * `walnut tools call task_send …` Bash call) folded into the live run and stood
 * as its own card once the saved row took over, so the run's phrase changed and
 * a card appeared at the turn end (2026-11-01, the user: streaming and finished
 * must look exactly the same, "no change of format"). Every exception lives
 * here; `tests/web/stream/tool-merge-parity.test.ts` checks both sides read it.
 */
import type { SessionHistoryTool } from '@/types/session';
import { detectOutboundSend } from '@/components/sessions/session-outbound';

/** Agent spawns: a chip of their own, never a run member. */
export const GROUPABLE_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** A Write into Claude Code's plans folder: its own collapsed line. */
export function isPlanWriteCall(name: string | undefined, input: Record<string, unknown> | undefined): boolean {
  return name === 'Write' && typeof input?.file_path === 'string' && input.file_path.includes('.claude/plans/');
}

/** A message to someone (a send, a thread update, a Brief write: an op card), read from
 *  the call's input so a call still running reads as its saved row. Not a run member,
 *  but a step of its turn: it joins the turn's fold, live or saved. */
export function isOutboundSendCall(tool: { name?: string; input?: Record<string, unknown>; result?: string }): boolean {
  const name = tool.name ?? 'unknown';
  if (GROUPABLE_TOOLS.has(name)) return false;
  return !!detectOutboundSend({ name, input: tool.input ?? {} } as SessionHistoryTool, tool.result);
}

/** True when the call folds into the run around it, live or saved. */
export function toolMergesIntoRun(tool: { name?: string; input?: Record<string, unknown>; result?: string }): boolean {
  const name = tool.name ?? 'unknown';
  if (GROUPABLE_TOOLS.has(name)) return false;
  if (name === 'ExitPlanMode') return false;
  if (isPlanWriteCall(name, tool.input)) return false;
  // A message to another session is conversation, not plumbing: folded into
  // "Ran a command" it vanishes from the timeline the way the inbound card
  // never does. Decided by the call's input alone, so a call still running
  // reads the same as its saved row.
  if (isOutboundSendCall(tool)) return false;
  // No input and no result: nothing a run's summary could count.
  if (!tool.result && (!tool.input || Object.keys(tool.input).length === 0)) return false;
  return true;
}
