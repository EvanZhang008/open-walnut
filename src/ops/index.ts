/**
 * Registry entry point — importing this module loads every op module (their
 * defineOp calls run at import time) and re-exports the registry + executor.
 *
 * EVERY surface (MCP server, CLI `tools`, gateway dispatch) imports the
 * registry through here, so "which ops exist" can never differ per surface.
 * Add a new op module? Import it below — that's the whole wiring.
 */

import './tasks.js'
import './core.js'

export { defineOp, listOps, getOp, opNames, type WalnutOp, type HttpBinding } from './registry.js'
export { executeOp, resolveApiBase, materializeBinding, type OpOutcome } from './executor.js'
