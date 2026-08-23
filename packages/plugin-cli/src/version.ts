import { readFileSync } from 'node:fs'

/**
 * Single source of truth for the versions this CLI prints and writes into a
 * scaffold. Everything here is READ FROM THIS PACKAGE'S OWN package.json, so a
 * release bumps one file and the `--version` output, the generated dependency
 * ranges, and the generated `engines.walnut` floor all follow.
 *
 * `../package.json` resolves the same way from `src/` (tests, tsx) and from
 * `dist/` (the published bin), because both live one level under the package
 * root. npm always ships package.json, whatever `files` says.
 */
interface CliPackageMetadata {
  version?: unknown
  dependencies?: Record<string, unknown>
  walnut?: { engineFloor?: unknown }
}

const PACKAGE_URL = new URL('../package.json', import.meta.url)

function readOwnPackage(): CliPackageMetadata {
  try {
    return JSON.parse(readFileSync(PACKAGE_URL, 'utf8')) as CliPackageMetadata
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read @open-walnut/plugin-cli package metadata: ${reason}`)
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`@open-walnut/plugin-cli package.json is missing ${field}`)
  }
  return value.trim()
}

const metadata = readOwnPackage()

/** This CLI's own version (`walnut-plugin --version`). */
export const CLI_VERSION = required(metadata.version, '"version"')

/** Range a scaffolded plugin depends on for the plugin API. */
export const PLUGIN_API_RANGE = required(
  metadata.dependencies?.['@open-walnut/plugin-api'],
  '"dependencies"."@open-walnut/plugin-api"',
)

/** Range a scaffolded plugin depends on for this CLI. */
export const CLI_RANGE = `^${CLI_VERSION}`

/** Walnut floor written into a scaffolded manifest's `engines.walnut`. */
export const ENGINE_FLOOR = required(metadata.walnut?.engineFloor, '"walnut"."engineFloor"')
