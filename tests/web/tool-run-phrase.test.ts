/**
 * The collapsed tool-run line counts files for reads and edits, not calls: six
 * Edits to one index.html read "edited 6 files" beside a Changed view that
 * listed one file.
 */
import { describe, it, expect } from 'vitest'
import { isRoutedQuestion, toolRunPhrase } from '../../web/src/components/sessions/tool-run-phrase.js'

const edit = (file_path: string) => ({ name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } })
const read = (file_path: string) => ({ name: 'Read', input: { file_path } })

describe('toolRunPhrase', () => {
  it('many edits to one file are one edited file', () => {
    expect(toolRunPhrase([read('/r/index.html'), ...Array.from({ length: 6 }, () => edit('/r/index.html')), { name: 'Bash', input: { command: 'node --check x.js' } }]))
      .toBe('Read a file, edited a file, ran a command')
  })

  it('counts distinct files per category, Write and Edit together', () => {
    expect(toolRunPhrase([
      edit('/r/a.ts'), { name: 'Write', input: { file_path: '/r/b.ts', content: 'x' } }, edit('/r/a.ts'),
      read('/r/a.ts'), read('/r/a.ts'), read('/r/c.ts'),
    ])).toBe('Edited 2 files, read 2 files')
  })

  it('a call without a known path counts as its own file', () => {
    expect(toolRunPhrase([{ name: 'Edit' }, { name: 'Edit', input: {} }, edit('/r/a.ts')])).toBe('Edited 3 files')
    expect(toolRunPhrase([{ name: 'NotebookEdit', input: { notebook_path: '/r/n.ipynb' } }, { name: 'NotebookEdit', input: { notebook_path: '/r/n.ipynb' } }]))
      .toBe('Edited a file')
  })

  it('commands and other tools still count calls', () => {
    expect(toolRunPhrase([{ name: 'Bash', input: { command: 'ls' } }, { name: 'Bash', input: { command: 'ls' } }, { name: 'Grep' }, { name: 'Grep' }]))
      .toBe('Ran 2 commands, ran 2 searches')
  })
})

describe('a question in the tool run', () => {
  it('reads as asking, not as an anonymous tool', () => {
    expect(toolRunPhrase([{ name: 'AskUserQuestion' }])).toBe('Asked a question')
    expect(toolRunPhrase([{ name: 'AskUserQuestion' }, { name: 'Bash' }, { name: 'AskUserQuestion' }])).toBe('Asked 2 questions, ran a command')
  })

  it('a worker question Walnut sent to its leader is not a failure (worker-question.ts)', () => {
    const routed = 'In this team your questions go to your leader, "Triage" (task t-1), not to the user. Your question was sent to it as request rq-abc123.'
    expect(isRoutedQuestion('AskUserQuestion', routed)).toBe(true)
    expect(isRoutedQuestion('AskUserQuestion', `\n${routed}`)).toBe(true)
    // Anything else stays what it is: a user's deny, another tool, no text.
    expect(isRoutedQuestion('AskUserQuestion', 'User denied permission')).toBe(false)
    expect(isRoutedQuestion('Bash', routed)).toBe(false)
    expect(isRoutedQuestion('AskUserQuestion', undefined)).toBe(false)
  })
})
