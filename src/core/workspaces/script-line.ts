/**
 * The line a session's terminal is given to run a project script by hand
 * (scripts.ts). Pure: the web client imports it.
 *
 * It runs in a subshell, so the terminal's own folder stays where the user left
 * it, and a folder that is gone stops it before any of its commands run:
 * `(cd '<dir>' || exit 1; <command>)`. A command of several lines, or with a
 * `#`, goes to a non-interactive shell as one quoted argument: an interactive
 * zsh does not read `#` as a comment (no INTERACTIVE_COMMENTS by default), and
 * a typed comment there would become arguments (`rm -rf build # clean`).
 */

/** POSIX single-quoting: safe for any text, newlines included. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The line the Scripts menu types: the script, then one bold line naming how it
 * ended, so a result stands out in the scrollback. With `runId` the end line
 * carries it in an OSC sequence the terminal does not draw, so the web client
 * reads the end of THIS run, never one replayed from earlier output
 * (web/src/components/workspaces/script-results.ts).
 */
export function scriptTerminalRun(name: string, command: string, dir?: string, runId?: string): string {
  const tag = runId ? `\\033]1337;walnut-run=%s\\007` : ''
  const args = runId ? `${shellQuote(runId)} ${shellQuote(name)}` : shellQuote(name)
  // With `runId` it starts by printing an undrawn mark too: the web client hides the
  // echo of this whole line up to it and shows the script's own command instead
  // (web/src/components/workspaces/script-echo.ts).
  const start = runId ? `printf '\\033]1337;walnut-run-start=%s\\007' ${shellQuote(runId)}; ` : ''
  return `${start}${scriptTerminalLine(command, dir)}; printf '\\n${tag}\\033[1m[%s exited with %s]\\033[0m\\n' ${args} "$?"`
}

/**
 * Ctrl-C ends the script with 130 (the subshell's trap), so the end line still
 * prints: a subshell killed by the signal would make the shell drop the rest of the line.
 */
export function scriptTerminalLine(command: string, dir?: string): string {
  const body = command.replace(/\r\n?/g, '\n').trim()
  const cd = dir ? `cd ${shellQuote(dir)} || exit 1; ` : ''
  const trap = `trap 'exit 130' INT; `
  if (!body.includes('\n') && !body.includes('#')) return `(${trap}${cd}${body})`
  return `(${trap}${cd}"\${SHELL:-sh}" -c ${shellQuote(body)})`
}
