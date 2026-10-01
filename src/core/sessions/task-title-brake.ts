/**
 * Short titles for the tasks a SESSION files.
 *
 * A model calling task_create tends to put the whole brief in the title
 * ("<ticket> mitigation: mark the leaked test consumer configs in both gamma
 * tables and request a quota of 2000 in both cells", 2026-09-30: a board row
 * nobody could scan). Walnut's own titles are a few words: a session title
 * names its specific subject in 2-6 words (session-title-backend.ts), a fork
 * label is 2-4 (fork-title.ts). The op description asks the model for the same;
 * this module is the brake behind that ask, so the board never depends on the
 * model reading it.
 *
 * What the brake does, for a title over SESSION_TITLE_MAX characters from a
 * caller that is a session (a worker, a Personal AI ask, an untracked session):
 *   1. cuts it to its head at once (heuristicShortTitle), so the long form never
 *      reaches the board or the response;
 *   2. keeps the long form as the task's description when the create carried
 *      none, so nothing the model wrote is lost;
 *   3. refines the cut in the background with Walnut's fast model, the same
 *      recipe that titles sessions (refineShortTitle), and writes the answer only
 *      while the task still wears the cut: a rename that landed in between wins.
 * Why not inline model calls: the fast model may ride the `claude` CLI, where one
 * turn is a process spawn (5-9s warm, 60s budget), and a create must not wait
 * for that. Why a rewrite and not a 400: the outcome has to hold whether or not
 * the model complies on retry, and a cut head reads fine on the board.
 *
 * Humans and the phone are never touched (no caller header): a long title a
 * person typed is their call.
 */

import { log } from '../../logging/index.js';

/** The commit-subject convention: a row the eye takes in at once. */
export const SESSION_TITLE_MAX = 60;

/** The head of a title ends at the first of these when what precedes is a title
 *  of its own ("<ticket> mitigation: mark ..." → "<ticket> mitigation"). */
const HEAD_BREAKS = [': ', ' - ', ' – ', ' — ', '. ', '; ', '：', '。', '；'];
/** A head this short is a label, not a title ("Fix: ...", "Task: ..."). */
const MIN_HEAD = 8;
/** Words a cut must not end on. */
const TRAILING_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'by', 'at',
  'from', 'into', 'both', 'that', 'which', 'as', 'is', 'are', 'be', 'via',
]);

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Whether a session's title is long enough for the brake. */
export function needsShortening(title: string): boolean {
  return tidy(title).length > SESSION_TITLE_MAX;
}

/**
 * The cut the board shows at once. Never empty for a non-empty title, never over
 * SESSION_TITLE_MAX characters, no trailing punctuation or stopword.
 */
export function heuristicShortTitle(title: string): string {
  const full = tidy(title);
  if (full.length <= SESSION_TITLE_MAX) return full;
  let cut = '';
  for (const br of HEAD_BREAKS) {
    const at = full.indexOf(br);
    if (at >= MIN_HEAD && at <= SESSION_TITLE_MAX && (cut === '' || at < cut.length)) cut = full.slice(0, at);
  }
  if (!cut) {
    const words = full.split(' ');
    const kept: string[] = [];
    for (const w of words) {
      const next = kept.length ? `${kept.join(' ')} ${w}` : w;
      if (next.length > SESSION_TITLE_MAX) break;
      kept.push(w);
    }
    while (kept.length > 1 && TRAILING_STOPWORDS.has(kept[kept.length - 1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) kept.pop();
    // One word longer than the cap (or text without spaces): a hard cut.
    cut = kept.length ? kept.join(' ') : full.slice(0, SESSION_TITLE_MAX);
  }
  cut = cut.replace(/[\s,;:.\-–—、，；：。]+$/u, '').trim();
  return cut || full.slice(0, SESSION_TITLE_MAX).trim();
}

/**
 * Background refine: Walnut's fast model names the task from the long form (and
 * the description when it says more), under the plugin's title rule for the
 * task's project. Writes only while the task still wears `cut`. Never throws.
 */
export async function refineShortTitle(
  taskId: string,
  cut: string,
  original: string,
  description?: string,
): Promise<void> {
  try {
    const { backendTitleAvailable, titleViaBackendModel } = await import('../session-title-backend.js');
    // The gate every unprompted model call respects: test servers and constrained
    // deployments make none, and the cut head is a fine title to keep.
    if (!backendTitleAvailable()) return;
    const { getTask, updateTask, pluginContentRequirement } = await import('../task-manager.js');
    const before = await getTask(taskId).catch(() => null);
    if (!before || before.title !== cut) return;
    const rule = pluginContentRequirement(before, 'title');
    const requirement = [
      `This names a TASK on the user's board, not a session: at most ${SESSION_TITLE_MAX} characters.`,
      rule ?? '',
    ].filter(Boolean).join(' ');
    const desc = (description ?? '').trim();
    const brief = desc && desc !== original.trim() ? `${original.trim()}\n\n${desc}` : original.trim();
    const answer = await titleViaBackendModel(brief, cut, requirement);
    if (!answer || answer === cut) {
      log.web.info('task title brake: keeping the cut head', { taskId, reason: answer ? 'unchanged' : 'no answer' });
      return;
    }
    // A model that overran the limit still gets its head used, never the long form.
    const title = answer.length > SESSION_TITLE_MAX ? heuristicShortTitle(answer) : answer;
    // Re-read under the same rule: a rename by the user or the agent since the
    // create (or the first read) wins over a background refine.
    const now = await getTask(taskId).catch(() => null);
    if (!now || now.title !== cut) return;
    await updateTask(taskId, { title }, { source: 'title-brake', asyncPush: true });
    log.web.info('task title brake: refined', { taskId, title, cut });
  } catch (err) {
    log.web.warn('task title brake: refine failed (keeping the cut head)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
