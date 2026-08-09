/**
 * Synth-only test config for the CDK app. Single-threaded and short: these tests
 * synthesize CloudFormation templates in-process and make no AWS calls, so they
 * need no credentials and no fixture server.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One fork: CDK synth writes to cdk.out, and the repo caps local test
    // fan-out machine-wide (see tests/setup/worker-budget.ts in the root).
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
  },
})
