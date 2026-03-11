/**
 * QuestionPopover — floating popover above chat input for ask_question tool.
 *
 * Renders as a popover (like SessionPathSelector) with page-per-question
 * navigation. Single-select auto-advances; multi-select has Next button.
 * Last page shows Submit. Answered state closes popover; inline summary
 * shows in the message bubble.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { wsClient } from '@/api/ws'

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

interface QuestionPopoverProps {
  open: boolean
  questions: QuestionItem[]
  onClose: () => void
}

export function QuestionPopover({ open, questions, onClose }: QuestionPopoverProps) {
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [customText, setCustomText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const current = questions[page]
  const key = current?.header ?? String(page)
  const isLastPage = page >= questions.length - 1
  const selectedOpts = selections[key] ?? []

  // Reset state when questions change (new question set)
  useEffect(() => {
    setPage(0)
    setAnswers({})
    setSelections({})
    setCustomText('')
    setSubmitted(false)
  }, [questions])

  // Focus input when page changes or popover opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [page, open])

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
    wsClient.sendRpc('chat:answer-question', { answers: finalAnswers }).then(() => {
      onClose()
    }).catch(() => {
      setSubmitted(false)
    })
  }, [submitted, onClose])

  const handleNext = useCallback(() => {
    const answer = customText.trim() || selectedOpts.join(', ') || '(no answer)'
    const updated = { ...answers, [key]: answer }
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
  }, [customText, selectedOpts, answers, key, isLastPage, questions, submitAll])

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

  if (!open || questions.length === 0) return null

  return (
    <div className="question-popover">
      {/* Header */}
      <div className="qp-header">
        <span className="qp-header-icon">&#x2753;</span>
        <span className="qp-header-title">Agent has a question</span>
        {questions.length > 1 && (
          <span className="qp-header-page">{page + 1} / {questions.length}</span>
        )}
      </div>

      {/* Question body */}
      <div className="qp-body">
        {current?.header && (
          <div className="qp-chip">{current.header}</div>
        )}
        <div className="qp-question">{current?.question}</div>

        {/* Option pills */}
        {current?.options && current.options.length > 0 && (
          <div className="qp-options">
            {current.options.map(opt => (
              <button
                key={opt.label}
                className={`qp-option ${selectedOpts.includes(opt.label) ? 'qp-option-selected' : ''}`}
                onClick={() => handleOptionClick(opt.label)}
                title={opt.description}
                disabled={submitted}
              >
                {opt.label}
                {opt.description && <span className="qp-option-desc">{opt.description}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="qp-input-row">
          <input
            ref={inputRef}
            className="qp-input"
            placeholder={current?.options?.length ? 'Or type custom answer...' : 'Type your answer...'}
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitted}
          />
          <button
            className="qp-submit"
            onClick={handleNext}
            disabled={submitted}
          >
            {submitted ? 'Sending...' : isLastPage ? 'Submit' : 'Next \u203A'}
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
