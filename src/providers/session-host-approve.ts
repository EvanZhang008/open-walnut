/**
 * `walnut __session-host-approve [--once] -- <program> [args...]`: the deploy's way
 * to run the compiled file under Walnut.app (scripts/dev-prod.sh, host_prefix_for):
 * the production server, and with `--once` a run that ends by itself (the
 * self-test, the smoke boot, the plugin check).
 *
 * Approves the command in the session host's manifest and prints the host
 * executable on stdout, exit 0. When the server cannot run under the host (no
 * Walnut.app, one too old to know the flag, not macOS, WALNUT_SESSION_HOST=0) it
 * prints the reason on stderr and exits 3, and the deploy launches the file
 * directly as before. Usage errors exit 2.
 */
import { approveUnderSessionHost } from './session-host.js';

export async function runSessionHostApprove(args: readonly string[]): Promise<number> {
  const once = args[0] === '--once';
  const rest = once ? args.slice(1) : args;
  if (rest[0] !== '--' || rest.length < 2) {
    process.stderr.write('usage: walnut __session-host-approve [--once] -- /absolute/program [args...]\n');
    return 2;
  }
  const result = await approveUnderSessionHost(rest.slice(1), { once });
  if (result.ok) {
    process.stdout.write(`${result.executable}\n`);
    return 0;
  }
  if (result.reason === 'bad_argv') {
    process.stderr.write(`walnut __session-host-approve: ${result.detail}\n`);
    return 2;
  }
  process.stderr.write(`session host not used: ${result.reason}${result.detail ? ` (${result.detail})` : ''}\n`);
  return 3;
}
