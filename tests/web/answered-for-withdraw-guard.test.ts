/**
 * Wherever the web app shows that a lead, VP or Main answered a task's ask for the user
 * (user_status.answeredFor), the user can take that answer back there (2026-11-08, the Personal VP's
 * reflection: an answer given on his older words could not be undone, so the ask never came back to
 * his Needs you). Enumerated from the source: a NEW view that reads answeredFor fails here until it
 * offers Withdraw (WithdrawAnswerButton / AnsweredForLine) or is listed as a model that feeds one.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
function files(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...files(rel))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel)
  }
  return out
}
const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Files that read answeredFor without drawing it themselves, and the view that draws it with Withdraw. */
const MODELS: Record<string, string> = {
  'web/src/components/board/board-status-model.ts': 'web/src/components/board/BoardStatusView.tsx',
}

describe('an answer given for the user can be taken back wherever it shows', () => {
  const readers = files('web/src').filter((f) => /\banswered[Ff]or\b|answeredForWords\(/.test(code(f)))

  it('every view that reads it offers Withdraw', () => {
    for (const f of readers) {
      if (f === 'web/src/components/tasks/AnsweredForLine.tsx') continue
      if (MODELS[f]) continue
      expect(code(f), `${f} shows an answer given for the user: offer WithdrawAnswerButton there, or list it in MODELS with the view that does`).toMatch(/<(WithdrawAnswerButton|AnsweredForLine)\b/)
    }
  })

  it('each model feeds a view that offers it', () => {
    for (const [model, view] of Object.entries(MODELS)) {
      expect(readers, `${model} no longer reads answeredFor: drop it from MODELS`).toContain(model)
      expect(code(view)).toMatch(/<(WithdrawAnswerButton|AnsweredForLine)\b/)
    }
  })

  it('the task details show the line, and the button calls the withdraw route', () => {
    expect(code('web/src/components/tasks/TaskDetailPane.tsx')).toContain('<AnsweredForLine')
    expect(code('web/src/api/tasks.ts')).toContain('/ask-answer/withdraw')
  })
})
