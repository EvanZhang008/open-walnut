/**
 * The mock CLI reads Walnut's spawn argv the way the real one does: every flag
 * Walnut passes is known with the value it takes, and only a bare argument is
 * the first turn's message (tests/providers/mock-claude-flags.mjs says why).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BARE_FLAGS, knownFlag, VALUE_FLAGS } from './mock-claude-flags.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MOCK = path.join(import.meta.dirname, 'mock-claude.mjs')

/** The files in src/ that build a claude CLI argv. */
const ARGV_BUILDERS = [
  'src/providers/claude-code-session.ts',
  'src/providers/spawn-template.ts',
  'src/providers/inline-subagent.ts',
  'src/providers/daemon-cron-supervision.ts',
  'src/core/sessions/spawn-prefix.ts',
]

/** The `--flag` string literals of a source file, outside comments. */
function flagLiterals(file: string): string[] {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n')
  return [...new Set([...code.matchAll(/['"`](--[a-zA-Z][a-zA-Z-]*)/g)].map((m) => m[1]!))]
}

describe('the mock CLI knows every flag Walnut passes', () => {
  it('each claude argv builder in src/ names only flags the mock knows', () => {
    const unknown = ARGV_BUILDERS.flatMap((file) => flagLiterals(file).filter((f) => !knownFlag(f)).map((f) => `${file}: ${f}`))
    expect(unknown, 'add the flag to tests/providers/mock-claude-flags.mjs, in VALUE_FLAGS when it takes a value').toEqual([])
    expect(ARGV_BUILDERS.flatMap(flagLiterals)).toContain('--permission-prompt-tool')
  })

  it('no flag is listed both with a value and without one', () => {
    expect([...VALUE_FLAGS].filter((f) => BARE_FLAGS.has(f))).toEqual([])
  })

  it('only a bare argument is the message: no flag or flag value is', async () => {
    // The old loop read every argument it did not know as the message, so the
    // last one won: here "stdio", the value of --permission-prompt-tool.
    const args = ['-p', '--output-format', 'json', 'the prompt', '--settings', '{"env":{}}',
      '--mcp-config', '{"mcpServers":{}}', '--permission-prompt-tool', 'stdio', '--some-future-flag']
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [MOCK, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
      let text = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { text += chunk })
      child.on('error', reject)
      child.on('exit', () => resolve(text))
    })
    const result = String((JSON.parse(out) as { result: unknown }).result)
    expect(result).toContain('I processed your message: the prompt')
    expect(result).not.toContain('stdio')
  }, 15_000)

  it('a spawn with Walnut\'s argv answers its first FIFO line, even one written late', async () => {
    // The tail of every Walnut spawn (claude-code-session.ts): `stdio` used to become
    // the message, and a first line written after the mock's 500 ms read was lost.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--debug',
      '--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
      '--session-id', '6f1c1a4e-0000-4000-8000-000000000001', '--settings', '{"env":{}}',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']
    const child = spawn(process.execPath, [MOCK, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.stdout.on('data', (chunk: string) => {
        out += chunk
        for (const line of out.split('\n')) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>
            if (event.type === 'result') resolve(event)
          } catch { /* a partial line */ }
        }
      })
      child.on('exit', (code) => reject(new Error(`the mock exited (${code}) before a result: ${out}`)))
    })
    try {
      // Past the mock's 500 ms first read even when its start is slow.
      await new Promise((r) => setTimeout(r, 1200))
      expect(child.exitCode, 'the mock must wait for its first line, not answer an argument').toBeNull()
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'the late first line' } }) + '\n')
      const event = await result
      expect(String(event.result)).toContain('the late first line')
      expect(String(event.result)).not.toContain('stdio')
    } finally {
      child.kill()
    }
  }, 15_000)
})
