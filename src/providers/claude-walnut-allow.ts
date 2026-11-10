/** Auto may deny before can_use_tool reaches Walnut. Preapprove only Walnut's
 * coordination ops, using Claude Code's own rules; its deny/ask rules still win. */
import { opNames } from '../ops/registry.js'
import { walnutOpAnswered } from './acp-permission-posture.js'

export function walnutCoordinationAllowRules(): string[] {
  // Creating a task is the normal way a lead delegates work. External operations,
  // credentials, browser control and host commands remain outside this grant.
  // The CLI/server loads the registry before launching; importing its entry
  // here would create a provider -> all ops -> provider initialization cycle.
  const ops = [...new Set(['task_create', ...opNames().filter(op => walnutOpAnswered(op))])]
  return [
    'Bash(walnut guide)', 'Bash(walnut tools list)', 'Bash(walnut tools help *)',
    ...ops.flatMap(op => [`mcp__walnut__${op}`, `Bash(walnut tools call ${op}:*)`]),
  ]
}
