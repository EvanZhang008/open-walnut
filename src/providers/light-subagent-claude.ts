/**
 * One light-subagent prompt on Claude Code: a `claude -p` child of this machine's daemon
 * (oneshot-client.ts, like every Claude Code process Walnut starts outside a session),
 * in the parent's directory, with the user's own settings and the model the caller
 * named (none: the CLI's own default). Its own limit, never the AI search slots.
 */
import { log } from '../logging/index.js'
import { LightSubagentError, type LightRunResult, type LightRunSpec } from '../core/subagents/types.js'

const PROGRESS_TEXT_MAX = 20_000

export async function runClaudeLight(spec: LightRunSpec): Promise<LightRunResult> {
  if (spec.host !== '__local__') {
    throw new LightSubagentError('engine_unavailable',
      `A Claude Code subagent runs on this machine only, and this session runs on ${spec.host}. Use your own Agent tool there, or another engine.`)
  }
  const [{ startOneShot }, parser, { resolveClaudeCliExecutable }, { claudeFallbackCommand }, { WALNUT_UTILITY_ENTRYPOINT }] = await Promise.all([
    import('./oneshot-client.js'),
    import('./claude-stream-parser.js'),
    import('../core/claude-cli-detect.js'),
    import('../core/test-claude-guard.js'),
    import('./inline-subagent.js'),
  ])
  // --allow- grants bypass without selecting it, so --permission-mode decides.
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    ...(spec.model ? ['--model', spec.model] : []),
    ...(spec.effort ? ['--effort', spec.effort] : []),
    '--allow-dangerously-skip-permissions',
    '--permission-mode', spec.fullAccess ? 'bypassPermissions' : 'plan',
  ]
  const { CLAUDECODE: _nested, ...env } = process.env
  // Never listed as an importable session; its `walnut` calls act for the parent.
  env.CLAUDE_CODE_ENTRYPOINT = WALNUT_UTILITY_ENTRYPOINT
  env.WALNUT_SESSION_ID = spec.callerSid

  let answer = ''
  let result: import('./claude-stream-parser.js').ClaudeStreamResult | undefined
  let stderr = ''
  const onLine = (line: string) => {
    const parsed = parser.parseClaudeJsonlLine(line, { onResult: (r) => { result = r } })
    for (const block of parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : []) {
      if (block.type === 'text') {
        answer += block.content
        spec.onProgress({ kind: 'text', text: answer.slice(-PROGRESS_TEXT_MAX) })
      } else if (block.type === 'tool_call' && block.status === 'calling' && !block.parentToolUseId) {
        answer = ''
        spec.onProgress({ kind: 'tool', toolName: block.name })
      }
    }
  }
  if (spec.signal.aborted) throw new LightSubagentError('engine_error', 'The run was stopped', 409)
  const exit = await new Promise<import('./oneshot-client.js').OneShotExit>((resolve, reject) => {
    startOneShot({
      command: resolveClaudeCliExecutable() ?? claudeFallbackCommand(),
      args, cwd: spec.cwd, env, input: spec.prompt, endInput: true,
    }, {
      onLine,
      onStderr: (text) => { if (stderr.length < 10_000) stderr += text },
      onExit: resolve,
    }).then((handle) => {
      const stop = () => {
        handle.kill('SIGINT')
        setTimeout(() => handle.kill('SIGTERM'), 3_000).unref?.()
      }
      if (spec.signal.aborted) stop()
      else spec.signal.addEventListener('abort', stop, { once: true })
    }, reject)
  })
  if (spec.signal.aborted) throw new LightSubagentError('engine_error', 'The run was stopped', 409)
  const usage = result?.usage
  const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined
  if (!result || result.isError || exit.error) {
    const why = result?.result || exit.error || stderr.trim().slice(0, 500) || `claude exited with code ${exit.code ?? exit.signal}`
    log.agent.warn('light subagent: claude run failed', { runtimeId: spec.runtimeId, why: why.slice(0, 300) })
    throw new LightSubagentError('engine_error', `Claude Code: ${why}`)
  }
  return { answer: (result.result || answer).trim(), ...(tokens ? { tokens } : {}), warnings: [] }
}
