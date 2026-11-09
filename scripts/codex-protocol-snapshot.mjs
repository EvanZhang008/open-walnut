#!/usr/bin/env bun
/**
 * Writes the slice of `codex app-server`'s protocol that Walnut's direct Codex
 * client (src/providers/codex-app-server/) relies on, read from the TypeScript
 * that Codex generates for its own version:
 *
 *   codex app-server -c model_provider=... generate-ts --experimental --out <dir>
 *   bun scripts/codex-protocol-snapshot.mjs <dir> <codex-version>
 *
 * The output goes to tests/fixtures/codex-app-server/protocol-<version>.json and
 * tests/providers/codex-app-server-schema.test.ts checks the client against every
 * snapshot there. To support a new Codex: generate, snapshot, run the test.
 * (generate-ts makes no model call, but Walnut's hook still wants a provider named.)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [dir, version] = process.argv.slice(2)
if (!dir || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  process.stderr.write('usage: codex-protocol-snapshot.mjs <generate-ts dir> <codex version x.y.z>\n')
  process.exit(2)
}

// The types the client sends or reads. A type a version lacks is recorded as null.
const TYPES = [
  'InitializeParams', 'ThreadStartParams', 'ThreadStartResponse', 'ThreadResumeParams', 'ThreadResumeResponse',
  'TurnStartParams', 'TurnStartResponse', 'TurnSteerParams', 'TurnInterruptParams', 'Turn', 'TurnStatus', 'TurnError',
  'CodexErrorInfo', 'TurnCompletedNotification', 'TurnStartedNotification', 'ThreadTokenUsage', 'TokenUsageBreakdown',
  'ThreadTokenUsageUpdatedNotification', 'AskForApproval', 'SandboxPolicy', 'UserInput', 'ModelListParams', 'ModelListResponse', 'Model',
  'CommandExecutionRequestApprovalParams', 'CommandExecutionApprovalDecision', 'FileChangeRequestApprovalParams',
  'FileChangeApprovalDecision', 'PermissionsRequestApprovalParams', 'PermissionsRequestApprovalResponse',
  'McpServerElicitationRequestParams', 'McpServerElicitationRequestResponse', 'ToolRequestUserInputResponse',
  'ErrorNotification', 'AgentMessageDeltaNotification', 'ItemStartedNotification', 'ItemCompletedNotification',
]

function read(file) {
  try { return fs.readFileSync(path.join(dir, file), 'utf8') } catch { return null }
}

/** The declaration alone: no banner, no imports, one line. */
function body(src) {
  return src.split('\n')
    .filter((l) => !l.startsWith('import ') && !l.startsWith('//'))
    .join('\n')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const methods = (file) => {
  const src = read(file)
  if (src === null) throw new Error(`${file} is missing in ${dir}`)
  return [...new Set([...src.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]))].sort()
}

const types = {}
for (const name of TYPES) {
  const src = read(path.join('v2', `${name}.ts`)) ?? read(`${name}.ts`)
  types[name] = src === null ? null : body(src)
}

const snapshot = {
  codexVersion: version,
  generatedWith: 'codex app-server generate-ts --experimental',
  clientRequests: methods('ClientRequest.ts'),
  serverRequests: methods('ServerRequest.ts'),
  serverNotifications: methods('ServerNotification.ts'),
  types,
}

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'tests', 'fixtures', 'codex-app-server', `protocol-${version}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')
process.stdout.write(`${out}\n`)
