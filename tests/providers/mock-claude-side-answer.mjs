/**
 * The mock CLI's answer to a side_question, as a real model writes one for each question Walnut
 * asks between turns. Its own file so mock-claude-status-answer.test.ts can ask it every prompt
 * Walnut builds without running a whole CLI.
 */

/** The status lines a fixture turn reports: done, with one plain line on where it stands. */
export const MOCK_STATUS_LINES = 'FOR_USER_STATE: done\nFOR_USER_NOW: The fixture turn finished.';

const SUMMARY_LINES = 'EXEC_SUMMARY: The fixture turn finished.\nUSER_REQUEST: Validate the session flow.\nCONTEXT: An isolated test session.\nPROGRESS: The turn finished.\nREFERENCES: unchanged\nWORK_LOG: append: Finished the fixture turn.\nTITLE: unchanged\nRECAP: The fixture turn finished.\nPHASE_SIGNAL: conversational(user-asked-question)\nSTATUS: succeeded\nWHAT_I_DID: Answered the fixture prompt.\nNEXT_STEPS: Continue the conversation.\nBLOCKERS: none\nUSER_INTENT: question-pending\nVERIFIED: not-applicable';

export function sideQuestionAnswer(q) {
  // The Changed view's caption question (src/core/diff-summary.ts) gets a caption, as a real model
  // writes one, never its own prompt echoed back under "Side title:" (2026-11-10 review: a Demo with
  // this mock showed "Side title: Caption YOUR change to notes.md").
  const caption = q.match(/^Caption YOUR change to `([^`]+)`/);
  if (caption) return `Updates \`${caption[1]}\`.`;
  // Every question that asks for the status lines (FOR_USER_PROMPT: the turn-end status question,
  // the summary when it carries them, the unclear-ask retry) gets them. Echoing a title there left
  // every fixture turn reading "Waiting: its report on the turn that just ended" for the summary's
  // whole quiet window (2026-11-23: two browser specs' hand-back checks red for weeks).
  const status = q.includes('FOR_USER_STATE:') ? MOCK_STATUS_LINES : '';
  if (q.includes('PHASE_SIGNAL:') && q.includes('EXEC_SUMMARY:')) return (status ? `${status}\n` : '') + SUMMARY_LINES;
  if (status) return status;
  // Auto-title: "Side title: " + the first five words of the user's message line in the question
  // envelope (the same word logic as the titler).
  const msgLine = q.match(/User's first message: ([\s\S]*?)(?:\nReply with|$)/);
  const src = (msgLine ? msgLine[1] : q).trim().replace(/^(?:(?:slow|chunk-delay):\d+\s+)+/, '');
  return `Side title: ${src.split(/\s+/).slice(0, 5).join(' ')}`;
}
