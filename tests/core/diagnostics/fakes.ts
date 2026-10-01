/**
 * Shared fake probes for the doctor tests: every probe answers instantly with
 * a fixed, realistic value, so a test replaces only the one it is about.
 */
import type { DiagnosticsProbes } from '../../../src/core/diagnostics/doctor.js'
import { summarizeConfig } from '../../../src/core/diagnostics/local-probes.js'
import type { HostDiagnostics } from '../../../src/core/diagnostics/types.js'
import type { UpdateStatus } from '../../../src/core/self-update/update-check.js'
import type { Config } from '../../../src/core/types.js'

export const ENV = {
  HOME: '/Users/alice',
  SHELL: '/bin/zsh',
  PATH: '/usr/bin:/bin',
  AWS_BEARER_TOKEN_BEDROCK: 'FAKE-ENV-BEARER-TOKEN-0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-FAKEKEYFAKEKEYFAKEKEYFAKEKEY',
}

export const HOST: HostDiagnostics = {
  alias: 'devbox', label: 'devbox', hostname: 'devbox.example.com', user: 'alice',
  connected: true, phase: 'connected', runtime: null, daemonVersion: null, readiness: null, lastError: null,
}

export const never = <T>() => new Promise<T>(() => {})

export const PREFLIGHT = {
  claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native' as const, needsNode: false },
  compiler: { found: true, name: 'clang' },
  dtach: { found: true, path: '/opt/homebrew/bin/dtach' },
}

/** The update check as a test sees it: a source checkout, so nothing was asked. */
export const UPDATE: UpdateStatus = {
  enabled: false, reason: 'source',
  install: { kind: 'source', sourceDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut', manager: null, updateCommand: null },
  current: '0.4.5', latest: null, available: false, checkedAt: null, error: null, checking: false,
  packageUrl: 'https://www.npmjs.com/package/open-walnut',
}

export function fakeProbes(over: Partial<DiagnosticsProbes> = {}): Partial<DiagnosticsProbes> {
  return {
    loginShellPath: async () => '/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    daemonPreflight: async () => null,
    preflight: async () => PREFLIGHT,
    claudePath: () => '/Users/alice/.local/bin/claude',
    claudeFloor: async () => null,
    compiler: () => ({ found: true, name: 'clang' }),
    dtach: async () => ({ found: true, path: '/opt/homebrew/bin/dtach', source: 'system' }),
    sqlite: async () => ({ ok: true, version: '3.46.1' }),
    webAssets: async () => true,
    config: async () => summarizeConfig({ provider: { type: 'bedrock' }, agent: { main_model: 'claude-opus-5-5' } } as Config, ENV),
    server: () => ({
      node: 'v24.1.0', platform: 'darwin', arch: 'arm64', pid: 4242, nice: 0, port: 3456,
      dataDir: '/Users/alice/.open-walnut', uptimeMs: 60_000, mode: 'primary',
    }),
    hosts: async () => [HOST],
    daemonHello: async () => ({ version: '0.4.5', runtime: 'binary' }),
    update: async () => UPDATE,
    ...over,
  }
}
