/**
 * Pending question state for the main agent's ask_question tool.
 *
 * When the agent calls ask_question, the tool blocks (returns a Promise
 * that doesn't resolve until the user answers). This module holds the
 * pending question state and provides the resolve/reject interface.
 *
 * Only one ask_question call can be pending at a time (the agent loop
 * executes tools sequentially within a turn).
 *
 * Mirrors the AskUserQuestion pattern: one call, multiple questions.
 * Answers are keyed by question header (or index).
 */

import { log } from '../logging/index.js'

// ── Types (matches the AskUserQuestion pattern) ──

export interface AskQuestionItem {
  /** The question text. */
  question: string
  /** Short label (max 12 chars), used as answer key. */
  header?: string
  /** Predefined choices. */
  options?: Array<{ label: string; description?: string }>
  /** Allow selecting multiple options. */
  multiSelect?: boolean
}

export interface PendingQuestionState {
  questionId: string
  questions: AskQuestionItem[]
  resolve: (answers: Record<string, string>) => void
  reject: (err: Error) => void
  createdAt: number
}

// ── Singleton state ──

let pending: PendingQuestionState | null = null
let counter = 0

/**
 * Block until the user answers all questions.
 * Called from the ask_question tool — blocks the agent loop.
 */
export function waitForAnswers(questions: AskQuestionItem[]): { questionId: string; promise: Promise<Record<string, string>> } {
  if (pending) {
    throw new Error('Another ask_question call is already pending. Only one at a time.')
  }

  const questionId = `aq-${++counter}-${Date.now()}`
  const promise = new Promise<Record<string, string>>((resolve, reject) => {
    pending = { questionId, questions, resolve, reject, createdAt: Date.now() }
  })

  log.agent.info('ask_question: waiting for user answers', {
    questionId,
    questionCount: questions.length,
  })

  return { questionId, promise }
}

/** True when the agent is blocked waiting for an answer. */
export function hasPendingQuestion(): boolean {
  return pending !== null
}

/** Get current pending question (for UI display or routing). */
export function getPendingQuestion(): PendingQuestionState | null {
  return pending
}

/**
 * Submit answers to the pending question, unblocking the tool.
 * Called from chat handler or answer-question RPC.
 */
export function submitAnswers(answers: Record<string, string>): void {
  if (!pending) {
    log.agent.warn('submitAnswers called but no pending question')
    return
  }
  const qid = pending.questionId
  const p = pending
  pending = null
  log.agent.info('ask_question: answers received', { questionId: qid, answerCount: Object.keys(answers).length })
  p.resolve(answers)
}

/**
 * Submit a single text answer (for simple chat-input flow).
 * Maps the text to the first question's header.
 */
export function submitTextAnswer(text: string): void {
  if (!pending) {
    log.agent.warn('submitTextAnswer called but no pending question')
    return
  }
  // If only one question, use the text directly.
  // If multiple questions, the text covers the first; others default to '(no answer)'.
  const answers: Record<string, string> = {}
  for (let i = 0; i < pending.questions.length; i++) {
    const key = pending.questions[i].header ?? String(i)
    answers[key] = i === 0 ? text : '(no answer)'
  }
  submitAnswers(answers)
}

/**
 * Cancel the pending question (user aborted the turn).
 */
export function cancelQuestion(): void {
  if (!pending) return
  const qid = pending.questionId
  const p = pending
  pending = null
  log.agent.info('ask_question: cancelled', { questionId: qid })
  p.reject(new Error('Question cancelled by user'))
}
