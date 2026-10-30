/**
 * A resumed CLI that fails at startup, with a REAL Claude Code (Claude Code 2.1.314
 * exits 1 and prints the error on every startup failure): set
 * WALNUT_TEST_REAL_CLAUDE_BIN to its binary and run the live tier. It fails on a
 * broken --mcp-config before any network call, so it needs no account. Harness:
 * tests/helpers/startup-failure-twins.ts.
 */
import fs from 'node:fs'
import { describe, it } from 'vitest'
import { realCli, startupFailureTwinsSuite } from '../helpers/startup-failure-twins.js'

const bin = process.env.WALNUT_TEST_REAL_CLAUDE_BIN
if (bin && fs.existsSync(bin)) startupFailureTwinsSuite(realCli(bin))
else describe.skip('a resumed CLI that fails at startup (real Claude Code)', () => { it('needs WALNUT_TEST_REAL_CLAUDE_BIN', () => {}) })
