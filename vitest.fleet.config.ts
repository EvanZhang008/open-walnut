import { defineConfig } from 'vitest/config';
import { workerExecArgv } from './tests/setup/worker-budget';

// FLEET tests: Walnut's real programs on separate machines (Linux containers
// for the hosts, this machine for the Mac) with real SSH and real link faults
// (tests/fleet/README.md). Opt-in like the live tier: `npm run test:fleet`.
// The files are named `*.fleet.ts`, which no other config includes, so they
// never run in quick, unit, integration, e2e or CI. Each file skips itself with
// a message when Docker is not available. No exec guard: the Mac's ssh is the
// real one on purpose (tests/fleet/ssh-identity.ts gives it this run's key and
// config, and its hosts are the run's own containers on 127.0.0.1).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/prod-server-guard.ts', 'tests/setup/git-env-isolation.ts', 'tests/setup/worker-watchdog.ts'],
    include: ['tests/fleet/**/*.fleet.ts'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // One fleet at a time: each holds containers, a Mac server and its daemons.
        maxForks: 1,
        execArgv: workerExecArgv(),
      },
    },
  },
});
