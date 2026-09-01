/**
 * `walnut tools` help paths on the HUB cli (src/commands/tools.ts).
 *
 * The bug pinned here: commander's built-in help option swallowed `--help`
 * anywhere in the argv, so `walnut tools call <op> --help` printed commander's
 * own usage ("Options: -h, --help display help") instead of the op's schema —
 * the same complaint that produced a JSON parse error before (2026-09-01).
 * The command now declares helpOption(false) and runTools answers every form.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runTools } from '../../src/commands/tools.js'

/** Capture stdout without letting the catalog spill into the test output. */
async function capture(args: string[]): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')) })
  try {
    await runTools(args, {} as never)
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

afterEach(() => { process.exitCode = 0 })

describe('tools help forms all print a schema, never a parse error', () => {
  it('call <op> --help prints the op parameters', async () => {
    const out = await capture(['call', 'task_create', '--help'])
    expect(out).toContain('task_create')
    expect(out).toContain('Parameters:')
    expect(out).toContain('start_session (boolean, optional)')
    expect(out).not.toContain('display help for command')
  })

  it('call <op> -h is the same page', async () => {
    expect(await capture(['call', 'note_read', '-h'])).toContain('Parameters:')
  })

  it('help <op> prints that op only, not the whole catalog', async () => {
    const out = await capture(['help', 'note_edit'])
    expect(out).toContain('note_edit')
    expect(out).toContain('old_str (string, required)')
    expect(out).not.toContain('task_create')
  })

  it('bare --help prints the tools manual, and the catalog points at the skill', async () => {
    const manual = await capture(['--help'])
    expect(manual).toContain('walnut tools list')
    expect(manual).toContain('skill_read')

    const list = await capture(['list'])
    expect(list).toContain('args:')
    expect(list).toContain('skill_read')
  })
})
