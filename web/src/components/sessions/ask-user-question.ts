/**
 * AskUserQuestion permission-card logic (pure — no React, no DOM).
 *
 * The Claude Code CLI's `AskUserQuestion` tool is a requiresUserInteraction tool:
 * its permission check ALWAYS returns 'ask' (even under bypassPermissions), and the
 * tool echoes the `answers` field back out of the permission response's
 * `updatedInput`. So answering it is not "allow vs deny" — the allow response IS
 * the answer payload, and an allow with no `answers` tells the model the user
 * answered nothing.
 *
 * This module owns parsing the tool input and turning per-question UI selections
 * into the `answers` map the server injects. Rendering lives in
 * SessionChatHistory's PermissionRequestCard; the option pill styling reuses the
 * `qp-*` classes from the butler-side QuestionPopover.
 */

export interface AskQuestionOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  header?: string
  options: AskQuestionOption[]
  multiSelect: boolean
}

/**
 * Parse an AskUserQuestion tool input into questions, or null when the input
 * doesn't look like one (then the generic Allow/Deny card renders instead).
 * A question with a blank text is dropped: it has no usable answers key.
 */
export function parseAskUserQuestionInput(input: Record<string, unknown> | undefined): AskQuestion[] | null {
  if (!input || !Array.isArray(input.questions)) return null
  const parsed = (input.questions as unknown[])
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && !Array.isArray(q))
    .map((q) => ({
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' && q.header ? q.header : undefined,
      options: Array.isArray(q.options)
        ? (q.options as unknown[])
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o))
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' && o.description ? o.description : undefined,
          }))
          .filter((o) => o.label !== '')
        : [],
      multiSelect: q.multiSelect === true,
    }))
    .filter((q) => q.question !== '')
  return parsed.length > 0 ? parsed : null
}

/**
 * Build the `answers` map (question text → answer string) the server merges into
 * the tool's input. Free text wins over the option pills (an "Other" answer is a
 * deliberate override); multi-select options join with ', ' the way the CLI's own
 * multi-select summary reads. Questions the user left entirely blank are OMITTED
 * rather than sent as an empty string — the tool then reports only real answers.
 */
export function buildAskUserAnswers(
  questions: AskQuestion[],
  selections: Record<string, string[]>,
  otherText: Record<string, string>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const custom = (otherText[q.question] ?? '').trim()
    const picked = (selections[q.question] ?? []).filter((l) => l !== '')
    const answer = custom || picked.join(', ')
    if (answer) answers[q.question] = answer
  }
  return answers
}

/** True when every question has an answer — gates the Submit button. */
export function allAskUserQuestionsAnswered(
  questions: AskQuestion[],
  selections: Record<string, string[]>,
  otherText: Record<string, string>,
): boolean {
  const answers = buildAskUserAnswers(questions, selections, otherText)
  return questions.length > 0 && questions.every((q) => !!answers[q.question])
}

/**
 * Apply a click on an option pill. Single-select replaces the selection (and
 * clicking the selected pill again clears it); multi-select toggles membership.
 */
export function toggleAskUserSelection(
  current: string[] | undefined,
  label: string,
  multiSelect: boolean,
): string[] {
  const cur = current ?? []
  if (multiSelect) {
    return cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
  }
  return cur[0] === label ? [] : [label]
}
