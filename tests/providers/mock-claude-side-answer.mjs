/**
 * The mock CLI's answer to a side_question, as a real model writes one for each question Walnut
 * asks between turns. Its own file so mock-claude-status-answer.test.ts can ask it every prompt
 * Walnut builds without running a whole CLI.
 */

/** The status lines a fixture turn reports: done, with one plain line on where it stands. */
export const MOCK_STATUS_LINES = 'FOR_USER_STATE: done\nFOR_USER_NOW: The fixture turn finished.';

const SUMMARY_LINES = 'EXEC_SUMMARY: The fixture turn finished.\nUSER_REQUEST: Validate the session flow.\nCONTEXT: An isolated test session.\nPROGRESS: The turn finished.\nREFERENCES: unchanged\nWORK_LOG: append: Finished the fixture turn.\nTITLE: unchanged\nRECAP: The fixture turn finished.\nPHASE_SIGNAL: conversational(user-asked-question)\nSTATUS: succeeded\nWHAT_I_DID: Answered the fixture prompt.\nNEXT_STEPS: Continue the conversation.\nBLOCKERS: none\nUSER_INTENT: question-pending\nVERIFIED: not-applicable';

/**
 * A session told `reword-threads` in one of its messages answers the status question as a busy node
 * does (2026-11-23, the user's VP: each turn end rewrote all 12 threads it was asked, with new words
 * and the same state): one line per listed thread, its state as listed, words that change every
 * answer, except a thread whose card the question shows and asks to keep (status-threads.ts
 * CARD_KEEPS_LINE), as a model following it does. Off unless a message asks for it, so every other
 * fixture keeps its threads as they are.
 */
let rewordThreads = false;
let rewordCount = 0;
export function noteUserMessage(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ') : '';
  if (/\breword-threads\b/.test(text)) rewordThreads = true;
}

const LINE_STATE = { new: 'working', working: 'working', pending: 'waiting', answered: 'answered' };

function rewordedThreadLines(q) {
  if (!rewordThreads || !q.includes("This task's open threads")) return '';
  rewordCount += 1;
  const lines = [];
  const keeps = q.includes('takes no line while it stays answered');
  for (const m of q.matchAll(/\b(t\d+) "([^"]*)" \(([a-z]+)([^;)]*; card: "|)/g)) {
    if (keeps && m[4]) continue;
    const state = LINE_STATE[m[3]] ?? 'working';
    lines.push(`FOR_USER_THREAD: ${m[1]} | ${state} | ${m[2]}: check ${rewordCount} says it still stands as before.`);
  }
  return lines.join('\n');
}

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
  const threads = rewordedThreadLines(q);
  const status = q.includes('FOR_USER_STATE:') ? MOCK_STATUS_LINES + (threads ? `\n${threads}` : '') : '';
  if (q.includes('PHASE_SIGNAL:') && q.includes('EXEC_SUMMARY:')) return (status ? `${status}\n` : '') + SUMMARY_LINES;
  if (status) return status;
  // Auto-title: "Side title: " + the first five words of the user's message line in the question
  // envelope (the same word logic as the titler).
  const msgLine = q.match(/User's first message: ([\s\S]*?)(?:\nReply with|$)/);
  const src = (msgLine ? msgLine[1] : q).trim().replace(/^(?:(?:slow|chunk-delay):\d+\s+)+/, '');
  return `Side title: ${src.split(/\s+/).slice(0, 5).join(' ')}`;
}
