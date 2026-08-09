/**
 * Child-process runner for the drivers that shell out to a vendor CLI (azure →
 * `az`, gcp → `gcloud`). One primitive instead of a copy per driver.
 *
 * aws.ts has its own older runStreaming and is deliberately left alone: it is
 * covered by its own tests, and folding it in here belongs in a refactor of its
 * own rather than riding along with a new provider.
 *
 * Two details are load-bearing:
 *
 *   - stdout and stderr are captured SEPARATELY. gcloud writes progress notes
 *     and warnings to stderr, so an interleaved capture would make
 *     `JSON.parse(stdout)` fail for reasons that have nothing to do with the
 *     command. `output` keeps the interleaved text for error messages and for
 *     pattern checks like aws's "has not been bootstrapped".
 *   - the promise settles only after BOTH pipes have ended AND 'close' fired.
 *     Node's own 'close' already implies that, but a resolve-on-close runner
 *     silently returns empty stdout against any fake child that ends its
 *     streams asynchronously — which is exactly what a stubbed spawn does.
 *
 * `onLog` is optional: a credential probe wants the captured output and nothing
 * in the operator-visible log; a provisioning call wants both.
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface CliResult {
  /** Exit code, or -1 when the process died without one. */
  code: number
  stdout: string
  stderr: string
  /** stdout + stderr in arrival order — for error text, not for parsing. */
  output: string
}

export interface RunCliOptions {
  timeoutMs: number
  /** Stream each line here, and echo the command itself. Omit to stay silent. */
  onLog?: (line: string) => void
  cwd?: string
  env?: NodeJS.ProcessEnv
  /**
   * Applied to the echoed command line and to every streamed line. Drivers that
   * put a secret-bearing value on the argv (aws's userDataB64) pass a scrubber;
   * drivers that keep secrets in files pass nothing.
   */
  redact?: (text: string) => string
}

/** Thrown when the CLI itself is missing, so callers can offer install advice. */
export class CliMissingError extends Error {
  readonly code = 'ENOENT'
  constructor(public readonly cmd: string) {
    super(`${cmd} is not installed or not on PATH`)
    this.name = 'CliMissingError'
  }
}

export async function runCli(cmd: string, args: string[], opts: RunCliOptions): Promise<CliResult> {
  const scrub = opts.redact ?? ((text: string) => text)
  opts.onLog?.(scrub(`$ ${cmd} ${args.join(' ')}`))

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // stdin ignored on purpose: a CLI that decides to prompt must hit EOF and
      // fail, never park the job forever waiting on a tty nobody is watching.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let output = ''
    let code = -1
    let closed = false
    let openStreams = 2
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${cmd} ${args[0] ?? ''} timed out after ${Math.round(opts.timeoutMs / 1000)}s`))
    }, opts.timeoutMs)
    timer.unref?.()

    const finish = (): void => {
      if (settled || !closed || openStreams > 0) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, output })
    }

    const wire = (stream: NodeJS.ReadableStream, isErr: boolean): void => {
      let buf = ''
      let done = false
      const end = (): void => {
        if (done) return
        done = true
        if (buf.trim()) opts.onLog?.(scrub(buf.trimEnd()))
        openStreams--
        finish()
      }
      stream.setEncoding('utf-8')
      stream.on('data', (chunk: string) => {
        output += chunk
        if (isErr) stderr += chunk
        else stdout += chunk
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) opts.onLog?.(scrub(line.trimEnd()))
      })
      stream.on('end', end)
      stream.on('error', end)
    }
    wire(child.stdout, false)
    wire(child.stderr, true)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject((err as { code?: string }).code === 'ENOENT' ? new CliMissingError(cmd) : err)
    })
    child.on('close', (exitCode) => {
      code = exitCode ?? -1
      closed = true
      finish()
    })
  })
}

/**
 * Write `content` to a 0600 file in a private temp dir, run `fn` with its path,
 * and delete the whole dir afterwards — on the failure path too.
 *
 * This exists because the first-boot script embeds the PAIRING CODE. `az` and
 * `gcloud` both take it as a file (`--custom-data @file`,
 * `--metadata-from-file`), and a file is the only safe channel: an argv value is
 * world-readable through /proc on the box running Walnut for as long as the CLI
 * lives, and it would also land in the operator-visible echo of the command.
 *
 * mkdtemp gives the dir mode 0700 already; the 0600 on the file is belt and
 * braces for a umask that would otherwise widen it.
 */
export async function withSecretFile<T>(
  prefix: string,
  filename: string,
  content: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  const file = path.join(dir, filename)
  try {
    await fsp.writeFile(file, content, { encoding: 'utf-8', mode: 0o600 })
    return await fn(file)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The verb of a CLI invocation — leading tokens up to the first flag, so
 * `['group','create','-n','x','-l','y']` reads as `group create`. Used to name
 * the failing command in an error without dumping its whole argv.
 */
export function cliVerb(args: string[]): string {
  const verb: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-')) break
    verb.push(arg)
  }
  return verb.join(' ')
}

/** Last few lines of stderr (falling back to stdout), for an error message. */
export function cliErrorDetail(res: CliResult, maxChars = 400): string {
  const text = (res.stderr.trim() || res.stdout.trim())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ')
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
}
