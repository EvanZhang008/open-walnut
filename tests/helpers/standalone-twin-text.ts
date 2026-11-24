import fs from 'node:fs'
import { daemonRuntimeText } from './daemon-runtime-text.js'

/**
 * daemon-standalone.ts as text checks read it.
 *
 * The daemon is a runtime its process creates (createDaemonRuntime): its body reads the
 * runtime's own env, `daemonEnv`. For the program run that is process.env (runDaemonProcess
 * passes it), so a check that looks for an expression on `process.env` (as the server's own
 * modules write it) reads the daemon with that one name mapped back. Only the standalone file
 * is mapped; any other text is returned as it is.
 */
export function twinText(rel: string, text: string): string {
  return rel.endsWith('daemon-standalone.ts') ? text.replace(/\bdaemonEnv\b/g, 'process.env') : text
}

/**
 * A file as the text checks read it. daemon-standalone.ts reads as the whole runtime: the file,
 * then the area modules its code moved to (daemon-git.ts, daemon-fs-read.ts, ..., each factory
 * body at column 0: daemon-runtime-text.ts), so a check of the daemon's code finds it wherever
 * it lives now. Any other file is read as it is.
 */
export function readTwinText(file: string): string {
  return twinText(file, file.endsWith('daemon-standalone.ts') ? daemonRuntimeText() : fs.readFileSync(file, 'utf-8'))
}

/**
 * The statements that hold the daemon's code: the body of createDaemonRuntime (its code lives
 * in that closure), then, in the runtime's whole text (daemonRuntimeText), the bodies of its area
 * modules' create<Area> factories, where code moved out of that body lives; or a file's own
 * statements when it has no createDaemonRuntime. For checks that look up one of the daemon's
 * functions in the parsed source.
 */
export function daemonStatements<S extends { statements: ReadonlyArray<unknown> }>(
  ts: typeof import('typescript'), source: S,
): ReadonlyArray<import('typescript').Statement> {
  const file = source as unknown as import('typescript').SourceFile
  const bodyOf = (node: import('typescript').Statement, name: RegExp) =>
    (ts.isFunctionDeclaration(node) && node.name && name.test(node.name.text) ? node.body : undefined)
  const runtime = file.statements.map((node) => bodyOf(node, /^createDaemonRuntime$/)).find(Boolean)
  if (!runtime) return file.statements
  const areas = file.statements.flatMap((node) => [...(bodyOf(node, /^create(?!DaemonRuntime$)[A-Z]\w*$/)?.statements ?? [])])
  return [...runtime.statements, ...areas]
}
