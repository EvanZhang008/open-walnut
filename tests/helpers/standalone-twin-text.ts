/**
 * daemon-standalone.ts as the twin text checks compare it with daemon-source.ts.
 *
 * The standalone twin is a runtime its process creates (createDaemonRuntime): its body reads
 * the runtime's own env, `daemonEnv`, where the source twin reads `process.env`. For the
 * program run they are the same object (runDaemonProcess passes process.env), so a check that
 * both twins compute a value from the same expression compares them with that one name mapped
 * back. Only the standalone file is mapped; any other text is returned as it is.
 */
export function twinText(rel: string, text: string): string {
  return rel.endsWith('daemon-standalone.ts') ? text.replace(/\bdaemonEnv\b/g, 'process.env') : text
}

/**
 * The statements that hold a twin's daemon code: the source twin's are its file's own, the
 * standalone twin's the body of createDaemonRuntime (its code lives in that closure). For checks
 * that look up one of the daemon's functions in the parsed source.
 */
export function daemonStatements<S extends { statements: ReadonlyArray<unknown> }>(
  ts: typeof import('typescript'), source: S,
): ReadonlyArray<import('typescript').Statement> {
  const file = source as unknown as import('typescript').SourceFile
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createDaemonRuntime' && node.body) return node.body.statements
  }
  return file.statements
}
