/**
 * `walnut trigger-check <template> '<params>'`: the check command of a
 * plugin's trigger template (src/core/routines/trigger-templates.ts).
 *
 * The daemon runs it like any check: the trigger input arrives on stdin, one
 * JSON line goes to stdout. It goes through the daemon's own gateway socket
 * (the daemon sets WALNUT_DAEMON_DIR for every check), so it reaches the server
 * that daemon serves; a URL from the environment can be wrong (a server on
 * port 0 hands its daemon WALNUT_SERVER_URL=http://localhost:0). Plain HTTP is
 * only the fallback for a host with no daemon socket at all.
 *
 * A server that cannot be reached, or a template not loaded yet, is not the
 * check failing: a deploy restarts Walnut for a minute, and five errors in a row
 * would stop the trigger. So that answer is a quiet run that keeps the cursor
 * until its grace runs out (trigger-check-core.ts templateCheckGap). Everything
 * else the server says is wrong (bad params, a plugin that failed) is an error.
 */

import {
  classifyTemplateHttp, templateCheckGap, templateCheckInput, templateCheckReplyMs, templateCheckRequestInput,
  type TemplateCheckInput,
} from '../providers/trigger-check-core.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3456'

export function triggerCheckBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPEN_WALNUT_API_URL?.trim() || env.WALNUT_SERVER_URL?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function answerGap(template: string, input: TemplateCheckInput, failure: 'unreachable' | 'missing', reason: string): void {
  const answer = templateCheckGap(input, failure, reason)
  if ('error' in answer) {
    process.stderr.write(`trigger-check ${template}: ${answer.error}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`trigger-check: ${reason}; quiet this run\n`)
  process.stdout.write(`${answer.line}\n`)
}

export async function runTriggerCheck(template: string, paramsJson: string | undefined): Promise<void> {
  const cli = await import('../providers/wn-cli.js')
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (cli.resolveWalnutCliEndpoint(process.env, cli.probeSocket, uid).ok) {
    process.exitCode = await cli.runWalnutCli(['trigger-check', template, ...(paramsJson !== undefined ? [paramsJson] : [])])
    return
  }
  let params: unknown = {}
  try {
    params = JSON.parse(paramsJson || '{}')
  } catch {
    process.stderr.write(`trigger-check: params are not JSON: ${paramsJson}\n`)
    process.exitCode = 2
    return
  }
  const input = templateCheckInput(await readStdin(), new Date().toISOString())
  const url = `${triggerCheckBaseUrl()}/api/v1/trigger-templates/${encodeURIComponent(template)}/check`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params, input: templateCheckRequestInput(input) }),
      signal: AbortSignal.timeout(templateCheckReplyMs(performance.now())),
    })
  } catch (err) {
    answerGap(template, input, 'unreachable', `Walnut at ${url} did not answer (${err instanceof Error ? err.message : String(err)})`)
    return
  }
  const text = await res.text()
  if (!res.ok) {
    let message = text.slice(0, 500)
    let code = ''
    try {
      const body = JSON.parse(text) as { error?: { code?: string; message?: string } | string; message?: string }
      if (typeof body.error === 'object') code = body.error?.code ?? ''
      message = (typeof body.error === 'object' ? body.error?.message : undefined) ?? body.message
        ?? (typeof body.error === 'string' ? body.error : message)
    } catch { /* the raw text */ }
    const failure = classifyTemplateHttp(res.status, code)
    if (failure !== 'error') {
      answerGap(template, input, failure, `Walnut answered ${res.status}: ${message}`)
      return
    }
    process.stderr.write(`trigger-check ${template}: ${message}\n`)
    process.exitCode = 1
    return
  }
  // One line, as the contract wants, whatever the server's formatting.
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`)
  } catch {
    process.stderr.write(`trigger-check ${template}: the server answered something that is not JSON\n`)
    process.exitCode = 1
  }
}
