/**
 * Who may pair a device with this machine's real Walnut from the CLI
 * (`walnut device add`, src/commands/device.ts). Pairing mints a credential, so
 * it is the user's decision (the team charter's approval rules). 2026-10-29: a
 * UI test agent ran `walnut device add` against production and created a device
 * in the real auth.json (it revoked it 25 s later).
 *
 * - A test run (WALNUT_TEST_RUN in the env) never pairs a device anywhere a
 *   person's Walnut reads: a test pairs with the ephemeral server it started.
 * - A Walnut session (WALNUT_SESSION_ID in the env, subagents included) pairs
 *   with the real data home only with `--production`, the session saying the
 *   user asked for this device. Pointing OPEN_WALNUT_HOME at an ephemeral
 *   server's data dir needs no flag.
 * - A person at a terminal is never asked.
 */

import os from 'node:os';
import path from 'node:path';
import { parseTestRunLabel } from './test-run.js';

export interface DeviceAddGuardInput {
  env: NodeJS.ProcessEnv;
  /** The data home this command writes (WALNUT_HOME). */
  home: string;
  /** --production: the session says the user asked for this device. */
  production: boolean;
  /** The account's own data home (tests pass one). */
  productionHome?: string;
}

/** Why `walnut device add` is refused here, or null to go ahead. */
export function deviceAddRefusal(input: DeviceAddGuardInput): string | null {
  const prodHome = path.resolve(input.productionHome ?? path.join(os.homedir(), '.open-walnut'));
  const real = path.resolve(input.home) === prodHome;
  const testRun = parseTestRunLabel(input.env.WALNUT_TEST_RUN);
  if (testRun && real) {
    return `Refused: a test run (WALNUT_TEST_RUN=${testRun}) never pairs a device with the real Walnut at ${prodHome}. `
      + 'Pair with the ephemeral server you started: OPEN_WALNUT_HOME=<its tmpDir>/.open-walnut walnut device add <name>.';
  }
  if (real && input.env.WALNUT_SESSION_ID && !input.production) {
    return `Refused: this pairs a device with the user's real Walnut (${prodHome}) and mints a credential, which is the user's call. `
      + 'A test pairs with the ephemeral server it started: OPEN_WALNUT_HOME=<its tmpDir>/.open-walnut walnut device add <name>. '
      + 'When the user asked for this device, run it again with --production.';
  }
  return null;
}
