/**
 * Vitest globalSetup — runs once before any test file in the worker pool.
 *
 * Sets WALNUT_HOME and NODE_ENV so that even child forks (which inherit
 * process.env) never resolve to the production ~/.open-walnut/ directory.
 *
 * This is Layer 1 of the production-data protection stack:
 *   L1: globalSetup env propagation (this file)
 *   L2: assertNotProductionPath() in constants.ts
 *   L3: hardcoded-path fixes in scripts/
 *   L4: lint grep guard
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function setup(): void {
  const prodHome = path.join(os.homedir(), '.open-walnut'); // safe: production-path — comparison only
  const current = process.env.OPEN_WALNUT_HOME;

  // If WALNUT_HOME is already set to a safe (non-production) path, keep it
  if (current && current !== prodHome && !current.startsWith(prodHome + path.sep)) {
    process.env.NODE_ENV = 'test';
    return;
  }

  // Force a temp dir that child forks will inherit
  const testHome = path.join(os.tmpdir(), 'open-walnut-test-global');
  fs.mkdirSync(testHome, { recursive: true });

  process.env.OPEN_WALNUT_HOME = testHome;
  process.env.NODE_ENV = 'test';
}
