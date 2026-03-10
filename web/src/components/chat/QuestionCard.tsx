/**
 * QuestionCard — small inline drawer, one question per page.
 *
 * Like AskUserQuestion: a compact drawer where each question
 * is its own "page". User answers one, then slides to the next. After the
 * last question, all answers are submitted together.
 *
 * States: pending (interactive, paged) → answered (collapsed summary).
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { wsClient } from '@/api/ws'

interface QuestionOption {
  label: string
  description?: string
}

interface QuestionItem {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

interface QuestionCardProps {
  questions: QuestionItem[]
  /** Tool is still waiting (status === 'calling') */
  pending: boolean
  /** Tool result text (shown after answered) */
  result?: string
}

export function QuestionCard({ questions, pending, result }: QuestionCardProps) {
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [customText, setCustomText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isAnswered = !pending || submitted
  const current = questions[page]
  const key = current?.header ?? String(page)
  const isLastPage = page >= questions.length - 1
  const selectedOpts = selections[key] ?? []

  // Focus input when page changes
  useEffect(() => {
    if (pending && inputRef.current) inputRef.current.focus()
  }, [page, pending])

  const toggleOption = useCallback((label: string) => {
    const multi = !!current?.multiSelect
    setSelections(prev => {
      const cur = prev[key] ?? []
      if (multi) {
        return { ...prev, [key]: cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label] }
      }
      return { ...prev, [key]: cur[0] === label ? [] : [label] }
    })
  }, [key, current?.multiSelect])

  const submitAll = useCallback((finalAnswers: Record<string, string>) => {
    if (submitted) return
    setSubmitted(true)
    wsClient.sendRpc('chat:answer-question', { answers: finalAnswers }).catch(() => {
      setSubmitted(false)
    })
  }, [submitted])

  /** Confirm current page answer and advance (or submit if last). */
  const handleNext = useCallback(() => {
    const answer = customText.trim() || selectedOpts.join(', ') || '(no answer)'
    const updated = { ...answers, [key]: answer }
    setAnswers(updated)
    setCustomText('')

    if (isLastPage) {
      // Fill in any missing answers
      const final: Record<string, string> = {}
      for (let i = 0; i < questions.length; i++) {
        const k = questions[i].header ?? String(i)
        final[k] = updated[k] ?? '(no answer)'
      }
      submitAll(final)
    } else {
      setPage(p => p + 1)
    }
  }, [customText, selectedOpts, answers, key, isLastPage, questions, submitAll])

  /** Single-select option click: auto-advance. */
  const handleOptionClick = useCallback((label: string) => {
    if (current?.multiSelect) {
      toggleOption(label)
      return
    }
    // Single-select: pick and immediately advance
    const updated = { ...answers, [key]: label }
    setAnswers(updated)
    setCustomText('')

    if (isLastPage) {
      const final: Record<string, string> = {}
      for (let i = 0; i < questions.length; i++) {
        const k = questions[i].header ?? String(i)
        final[k] = updated[k] ?? '(no answer)'
      }
      submitAll(final)
    } else {
      setPage(p => p + 1)
    }
  }, [current?.multiSelect, toggleOption, answers, key, isLastPage, questions, submitAll])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleNext()
    }
  }, [handleNext])

  // ── Answered / collapsed state ──
  if (isAnswered) {
    const answerSummary = questions.map((q, i) => {
      const k = q.header ?? String(i)
      return `${k}: ${answers[k] ?? '—'}`
    }).join(' · ')

    return (
      <div className="question-drawer question-drawer-answered">
        <div className="question-drawer-bar">
          <span className="question-drawer-icon">&#x2713;</span>
          <span className="question-drawer-title">Answered</span>
          <span className="question-drawer-summary">{answerSummary}</span>
        </div>
        {result && <div className="question-drawer-result">{result}</div>}
      </div>
    )
  }

  // ── Pending / interactive drawer ──
  return (
    <div className="question-drawer question-drawer-pending">
      {/* Progress bar */}
      <div className="question-drawer-bar">
        <span className="question-drawer-icon">&#x2753;</span>
        <span className="question-drawer-title">
          {questions.length === 1 ? 'Question' : `Question ${page + 1} / ${questions.length}`}
        </span>
        {current?.header && (
          <span className="question-drawer-chip">{current.header}</span>
        )}
      </div>

      {/* Current question */}
      <div className="question-drawer-page">
        <div className="question-drawer-question">{current?.question}</div>

        {/* Option buttons */}
        {current?.options && current.options.length > 0 && (
          <div className="question-drawer-options">
            {current.options.map(opt => (
              <button
                key={opt.label}
                className={`question-drawer-opt ${selectedOpts.includes(opt.label) ? 'question-drawer-opt-sel' : ''}`}
                onClick={() => handleOptionClick(opt.label)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* Text input + next/submit button */}
        <div className="question-drawer-input-row">
          <input
            ref={inputRef}
            className="question-drawer-input"
            placeholder={current?.options?.length ? 'Or type custom answer...' : 'Type your answer...'}
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="question-drawer-next"
            onClick={handleNext}
          >
            {isLastPage ? 'Submit' : 'Next \u203A'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Parse ask_question tool input into QuestionItem[].
 */
export function parseAskQuestionInput(input: Record<string, unknown> | undefined): QuestionItem[] | null {
  if (!input?.questions || !Array.isArray(input.questions)) return null
  return (input.questions as Record<string, unknown>[]).map((q) => ({
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
}
