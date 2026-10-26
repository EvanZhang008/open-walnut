// Where a script keeps evidence and reports someone reads after the run: the
// calling session's task directory when there is one (src/lib/task-dir.ts),
// else the user's state dir. Never /tmp, which a reboot empties (2026-10-25).
// Twin of scripts/lib/evidence-dir.sh.
import os from 'node:os'
import path from 'node:path'

export function evidenceRoot(env = process.env) {
  if (env.WALNUT_TASK_DIR && path.isAbsolute(env.WALNUT_TASK_DIR)) return path.join(env.WALNUT_TASK_DIR, 'evidence')
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(env.HOME || os.homedir(), '.local', 'state')
  return path.join(state, 'open-walnut', 'evidence')
}

/** `<root>/<name>`; the caller makes it (mkdirSync / mkdtempSync with this as the prefix dir). */
export function evidenceDir(name, env = process.env) {
  return path.join(evidenceRoot(env), name)
}
