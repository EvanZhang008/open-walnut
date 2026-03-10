/**
 * ask_question tool — lets the main agent ask the user questions mid-turn.
 *
 * Mirrors the AskUserQuestion pattern: one call, 1-4 questions,
 * each with optional predefined options. The tool blocks until the
 * user answers in the chat UI, then returns all answers to the agent.
 *
 * Flow:
 *   1. Agent calls ask_question with questions array
 *   2. onToolCall callback fires → UI renders QuestionCard
 *   3. Tool blocks (waitForAnswers returns a Promise)
 *   4. User answers via QuestionCard or normal chat input
 *   5. chat handler intercepts → submitAnswers/submitTextAnswer
 *   6. Promise resolves → tool returns formatted answers
 *   7. Agent continues in the same turn
 */

import type { ToolDefinition } from '../tools.js'
import { waitForAnswers, type AskQuestionItem } from '../../core/agent-question.js'

export const askQuestionTool: ToolDefinition = {
  name: 'ask_question',
  description:
    'Ask the user one or more questions and wait for their answers. ' +
    'Use when you need clarification, a decision, or input before proceeding. ' +
    'The questions appear in the chat UI and the user is notified. ' +
    'Supports predefined options (single or multi-select) and free-text answers. ' +
    'Returns answers keyed by each question\'s header.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'The questions to ask (1-4 questions per call).',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question text. Be clear and specific.',
            },
            header: {
              type: 'string',
              description: 'Short label (max 12 chars) used as the answer key. E.g. "Database", "Approach".',
            },
            options: {
              type: 'array',
              description: 'Predefined answer choices. User can also type a custom answer.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option display text (1-5 words).' },
                  description: { type: 'string', description: 'Optional explanation of this option.' },
                },
                required: ['label'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow selecting multiple options. Default: false.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },

  execute: async (params) => {
    const raw = params as { questions?: unknown }
    if (!raw.questions || !Array.isArray(raw.questions) || raw.questions.length === 0) {
      return 'Error: questions array is required and must not be empty.'
    }

    const questions: AskQuestionItem[] = (raw.questions as Record<string, unknown>[]).map((q, i) => ({
      question: String(q.question ?? ''),
      header: q.header ? String(q.header) : undefined,
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[]).map(o => ({
            label: String(o.label ?? ''),
            description: o.description ? String(o.description) : undefined,
          }))
        : undefined,
      multiSelect: q.multiSelect === true,
    }))

    // Assign default headers for questions that don't have one
    for (let i = 0; i < questions.length; i++) {
      if (!questions[i].header) {
        questions[i].header = questions.length === 1 ? 'Answer' : `Q${i + 1}`
      }
    }

    try {
      // This blocks until the user answers (or the turn is aborted)
      // The onToolCall callback has already fired, so the UI sees the tool_use
      // with the questions array in the input — QuestionCard renders from that.
      const { promise } = waitForAnswers(questions)
      const answers = await promise

      // Format answers for the agent
      const lines: string[] = []
      for (const q of questions) {
        const key = q.header!
        const answer = answers[key] ?? '(no answer)'
        lines.push(`[${key}]: ${answer}`)
      }
      return `User's answers:\n${lines.join('\n')}`
    } catch (err) {
      return `Question was cancelled: ${(err as Error).message}`
    }
  },
}
